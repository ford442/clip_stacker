import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
} from '../types';
import { resolveTimelineFinishing } from '../utils/finishing';
import type {
  PreviewCompositionPlan,
  PreviewDeviceState,
  TimelineCompositor,
  TimelineRenderOptions,
} from '../utils/previewComposition';
import { ClipMediaPool, seekVideoTo } from '../utils/clipMediaPool';
import { previewMetrics } from '../utils/previewMetrics';
import { resolvePreviewMedia, type PreviewMediaSource } from '../utils/proxyMedia';
import { proxyStore } from '../store/proxyStore';
import {
  groupFrameRequestsByMedia,
  toWorkerClip,
  type CapturedFrame,
  type FrameRequest,
  type FrameSourceStats,
  type ScopeData,
  type ScopeSettings,
} from './previewWorkerProtocol';
import { captureStillFrame, captureVideoFrame } from './captureFrame';
import { PreviewWorkerRuntime, type FrameCaptureCallback } from './previewWorkerRuntime';

// ---------------------------------------------------------------------------
// PreviewWorkerAdapter — TimelineCompositor wrapper for the worker runtime.
//
// Keeps ClipMediaPool on the main thread for VideoFrame capture, forwards
// all GPU work to the off-thread worker via PreviewWorkerRuntime.
// ---------------------------------------------------------------------------

/**
 * Implements the TimelineCompositor interface backed by the off-thread worker.
 * Frame capture (seek + VideoFrame) stays on the main thread; GPU compositing
 * runs in the worker on the transferred OffscreenCanvas.
 */
export class PreviewWorkerAdapter implements TimelineCompositor {
  private readonly runtime: PreviewWorkerRuntime;
  private readonly pool: ClipMediaPool;
  /**
   * Clip id → the preview blob last handed to the worker. A proxy finishing,
   * or the proxy toggle flipping, changes the resolved blob and re-sends it;
   * the worker drops that clip's cursors and reopens on the new bytes.
   */
  private readonly sentMedia = new Map<string, Blob>();

  private constructor(runtime: PreviewWorkerRuntime, pool: ClipMediaPool) {
    this.runtime = runtime;
    this.pool = pool;
  }

  /**
   * Create a worker-backed compositor.  Transfers canvas control to the worker
   * only after a successful GPU probe. Returns null if OffscreenCanvas or
   * WebGPU is unavailable — canvas is not transferred.
   */
  static async create(
    canvas: HTMLCanvasElement,
    clips: Clip[],
  ): Promise<PreviewWorkerAdapter | null> {
    const runtime = await PreviewWorkerRuntime.create(canvas);
    if (!runtime) return null;
    const adapter = new PreviewWorkerAdapter(runtime, new ClipMediaPool());
    adapter.sendClipMedia(clips);
    return adapter;
  }

  /** Scope bins for the composed preview frame (no-op when both toggles are off). */
  setScopes(scopes: ScopeSettings, listener?: (data: ScopeData) => void): void {
    this.runtime.setScopes(scopes, listener);
  }

  /** How the last frame's layers were sourced (decoder vs `<video>` seek). */
  get frameSources(): FrameSourceStats {
    return this.runtime.frameSources;
  }

  onDeviceState(listener: (state: PreviewDeviceState, message?: string) => void): () => void {
    return this.runtime.onDeviceState(listener);
  }

  /**
   * Transfer the preview blob — the ready proxy, else the source `File` — for
   * every decodable clip whose blob the worker does not already hold. Blobs
   * are structured-cloneable by reference, so this hands over a handle, not
   * the bytes.
   */
  private sendClipMedia(clips: Clip[]): void {
    const lookup = proxyStore.getState();
    const media: Array<{ clipId: string; blob: Blob; source: PreviewMediaSource }> = [];
    for (const clip of clips) {
      if (clip.kind !== 'video' || clip.stillImage || !clip.file) continue;
      const resolved = resolvePreviewMedia(clip, lookup);
      if (this.sentMedia.get(clip.id) === resolved.blob) continue;
      this.sentMedia.set(clip.id, resolved.blob);
      media.push({ clipId: clip.id, blob: resolved.blob, source: resolved.source });
    }
    this.runtime.sendClipMedia(media);
  }

  async renderTimelineFrame(
    clips: Clip[],
    groups: ClipGroup[],
    transitions: ClipTransition[],
    overlays: TextOverlay[],
    settings: Pick<ExportSettings, 'outputResolution'> | undefined,
    globalTime: number,
    options?: TimelineRenderOptions,
  ): Promise<PreviewCompositionPlan> {
    const captureOne = async (req: FrameRequest): Promise<CapturedFrame | null> => {
      if (options?.isCancelled?.()) return null;

      // RIFE morph segment — keyed by mediaObjectUrl.
      if (req.mediaObjectUrl) {
        const video = this.pool.getVideoForUrl(req.clipId, req.mediaObjectUrl);
        const seekStart = performance.now();
        await seekVideoTo(video, req.sourceTime);
        previewMetrics.recordSeek(performance.now() - seekStart);
        if (options?.isCancelled?.()) return null;
        const frame = await captureVideoFrame(video);
        if (!frame) return null;
        return {
          clipId: req.clipId,
          role: req.role,
          frame,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        };
      }

      const clip = clips.find((c) => c.id === req.clipId);
      if (!clip) return null;

      if (clip.stillImage) {
        const img = this.pool.getStillImage(clip);
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          });
        }
        if (options?.isCancelled?.()) return null;
        const frame = await captureStillFrame(img);
        if (!frame) return null;
        return {
          clipId: req.clipId,
          role: req.role,
          frame,
          videoWidth: img.naturalWidth,
          videoHeight: img.naturalHeight,
        };
      }

      if (clip.kind !== 'video') return null;

      // The <video> fallback reads the same bytes the worker decoder would.
      const media = resolvePreviewMedia(clip, proxyStore.getState());
      const fromProxy = media.source === 'proxy' && Boolean(media.objectUrl);
      const video = this.pool.getVideoForUrl(clip.id, fromProxy ? media.objectUrl : clip.objectUrl);
      const seekStart = performance.now();
      await seekVideoTo(video, req.sourceTime);
      previewMetrics.recordSeek(performance.now() - seekStart);
      if (options?.isCancelled?.()) return null;
      const frame = await captureVideoFrame(video);
      if (!frame) return null;
      return {
        clipId: req.clipId,
        role: req.role,
        frame,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        ...(fromProxy ? { proxy: true } : {}),
      };
    };

    const captureFrames: FrameCaptureCallback = async (requests) => {
      // Seek different media elements in parallel; keep same-element requests
      // sequential so the shared <video> does not thrash.
      const groupsOfRequests = groupFrameRequestsByMedia(requests);
      const groupResults = await Promise.all(
        groupsOfRequests.map(async (group) => {
          const captured: CapturedFrame[] = [];
          for (const req of group) {
            if (options?.isCancelled?.()) break;
            const frame = await captureOne(req);
            if (frame) captured.push(frame);
          }
          return captured;
        }),
      );
      return groupResults.flat();
    };

    const plan = await this.runtime.renderTimeline(
      {
        clips: clips.map(toWorkerClip),
        clipGroups: groups,
        transitions,
        textOverlays: overlays,
        exportSettings: settings,
        globalTime,
        maxWidth: options?.maxWidth,
        maxHeight: options?.maxHeight,
        finishing: resolveTimelineFinishing(options),
        colorManagement: options?.colorManagement,
        captions: options?.captions,
        captionStyle: options?.captionStyle,
      },
      captureFrames,
    );

    previewMetrics.setFrameSources(this.runtime.frameSources);

    if (!plan) {
      // Render was cancelled — throw so the caller's catch block handles it.
      // The caller checks isCancelled() first, so this won't count as a failure.
      throw new Error('render cancelled');
    }

    return plan;
  }

  syncClips(clips: Clip[]): void {
    const ids = new Set(clips.map((c) => c.id));
    this.pool.pruneExcept(ids);
    for (const id of [...this.sentMedia.keys()]) {
      if (!ids.has(id)) this.sentMedia.delete(id);
    }
    this.sendClipMedia(clips);
    previewMetrics.setDecoderCount(this.pool.size, this.pool.limit);
    this.runtime.syncClips(clips);
  }

  pauseDecoders(): void {
    this.pool.pauseAll();
    this.runtime.pauseDecoders();
  }

  resetFinishingTemporal(): void {
    this.runtime.resetFinishingTemporal();
  }

  destroy(): void {
    this.pool.destroy();
    this.sentMedia.clear();
    this.runtime.destroy();
  }
}
