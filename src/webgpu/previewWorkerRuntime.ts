/**
 * Main-thread proxy for the off-thread WebGPU preview worker.
 *
 * Transfers OffscreenCanvas to the worker on creation, then provides a
 * promise-based API for timeline rendering.  Frame capture (seek + VideoFrame)
 * stays on the main thread via a caller-supplied callback.
 */

import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import type { ColorGradeSettings } from '../utils/lut';
import type { PreviewCompositionPlan, TimelineCompositor, TimelineRenderOptions } from '../utils/previewComposition';
import { ClipMediaPool, seekVideoTo } from '../utils/clipMediaPool';
import { previewMetrics } from '../utils/previewMetrics';
import {
  toWorkerClip,
  type CapturedFrame,
  type FrameRequest,
  type PreviewWorkerInbound,
  type PreviewWorkerOutbound,
  type WorkerClip,
} from './previewWorkerProtocol';

export type { FrameRequest, CapturedFrame };

export interface RenderTimelineParams {
  clips: WorkerClip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings: Pick<ExportSettings, 'outputResolution'> | undefined;
  globalTime: number;
  maxWidth?: number;
  maxHeight?: number;
  colorGrade?: ColorGradeSettings;
}

/**
 * Called by the runtime when the worker needs frames for a render.
 * The callback must capture VideoFrames from hidden <video> elements and
 * return them.  All returned frames will be transferred to the worker
 * (caller must not access them after the callback resolves).
 */
export type FrameCaptureCallback = (
  requests: FrameRequest[],
) => Promise<CapturedFrame[]>;

interface PendingRender {
  resolve: (plan: PreviewCompositionPlan | null) => void;
  reject: (err: Error) => void;
  captureFrames: FrameCaptureCallback;
}

export class PreviewWorkerRuntime {
  private readonly worker: Worker;
  private nextRenderId = 0;
  private readonly pendingRenders = new Map<number, PendingRender>();
  private lastRenderId = -1;

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<PreviewWorkerOutbound>) =>
      this.handleMessage(event.data);
    worker.onerror = (event) => {
      const err = new Error(event.message ?? 'PreviewWorker error');
      for (const pending of this.pendingRenders.values()) pending.reject(err);
      this.pendingRenders.clear();
    };
  }

  /**
   * Create the runtime by transferring canvas control to the worker.
   * Returns null if OffscreenCanvas or WebGPU is unavailable.
   */
  static async create(canvas: HTMLCanvasElement): Promise<PreviewWorkerRuntime | null> {
    if (
      typeof OffscreenCanvas === 'undefined' ||
      typeof canvas.transferControlToOffscreen !== 'function'
    ) {
      return null;
    }

    const worker = new Worker(
      new URL('./preview.worker.ts', import.meta.url),
      { type: 'module' },
    );

    const runtime = new PreviewWorkerRuntime(worker);

    const webgpuAvailable = await new Promise<boolean>((resolve) => {
      // Override message handler temporarily to catch the 'ready' message
      // before any render messages can arrive.
      const originalHandler = (event: MessageEvent<PreviewWorkerOutbound>) => {
        if (event.data.type === 'ready') {
          worker.onmessage = (e: MessageEvent<PreviewWorkerOutbound>) =>
            runtime.handleMessage(e.data);
          resolve(event.data.webgpuAvailable);
        }
      };
      worker.onmessage = originalHandler;

      worker.onerror = () => resolve(false);

      const offscreen = canvas.transferControlToOffscreen();
      const initMsg: PreviewWorkerInbound = {
        type: 'init',
        canvas: offscreen,
        width: canvas.clientWidth || 1280,
        height: canvas.clientHeight || 720,
      };
      worker.postMessage(initMsg, [offscreen as unknown as Transferable]);
    });

    if (!webgpuAvailable) {
      worker.terminate();
      return null;
    }

    return runtime;
  }

  private handleMessage(msg: PreviewWorkerOutbound): void {
    switch (msg.type) {
      case 'ready': {
        // Handled during create(); ignored after init.
        break;
      }

      case 'need-frames': {
        const pending = this.pendingRenders.get(msg.renderId);
        if (!pending) break;

        pending
          .captureFrames(msg.requests)
          .then((frames) => {
            // VideoFrame is Transferable — transfer ownership to worker.
            const transferList = frames.map((f) => f.frame as unknown as Transferable);
            const response: PreviewWorkerInbound = {
              type: 'frames-ready',
              renderId: msg.renderId,
              frames,
            };
            this.worker.postMessage(response, transferList);
          })
          .catch((err) => {
            const pending = this.pendingRenders.get(msg.renderId);
            if (pending) {
              this.pendingRenders.delete(msg.renderId);
              pending.reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        break;
      }

      case 'render-complete': {
        const pending = this.pendingRenders.get(msg.renderId);
        this.pendingRenders.delete(msg.renderId);
        pending?.resolve(msg.plan);
        break;
      }

      case 'render-cancelled': {
        const pending = this.pendingRenders.get(msg.renderId);
        this.pendingRenders.delete(msg.renderId);
        pending?.resolve(null);
        break;
      }

      case 'error': {
        console.error('[PreviewWorker]', msg.message);
        const err = new Error(msg.message);
        for (const pending of this.pendingRenders.values()) pending.reject(err);
        this.pendingRenders.clear();
        break;
      }
    }
  }

  /**
   * Request a timeline render.  Resolves with the composition plan on success,
   * or null if the render was cancelled before it completed.
   */
  async renderTimeline(
    params: RenderTimelineParams,
    captureFrames: FrameCaptureCallback,
  ): Promise<PreviewCompositionPlan | null> {
    // Cancel any in-flight render — only the latest frame matters.
    if (this.lastRenderId >= 0 && this.pendingRenders.has(this.lastRenderId)) {
      this.cancel(this.lastRenderId);
    }

    const renderId = ++this.nextRenderId;
    this.lastRenderId = renderId;

    return new Promise<PreviewCompositionPlan | null>((resolve, reject) => {
      this.pendingRenders.set(renderId, { resolve, reject, captureFrames });

      const renderMsg: PreviewWorkerInbound = {
        type: 'render',
        renderId,
        clips: params.clips,
        clipGroups: params.clipGroups,
        transitions: params.transitions,
        textOverlays: params.textOverlays,
        exportSettings: params.exportSettings,
        globalTime: params.globalTime,
        maxWidth: params.maxWidth,
        maxHeight: params.maxHeight,
        colorGrade: params.colorGrade,
      };
      this.worker.postMessage(renderMsg);
    });
  }

  cancel(renderId: number): void {
    this.pendingRenders.delete(renderId);
    const msg: PreviewWorkerInbound = { type: 'cancel', renderId };
    this.worker.postMessage(msg);
  }

  resize(width: number, height: number): void {
    const msg: PreviewWorkerInbound = { type: 'resize', width, height };
    this.worker.postMessage(msg);
  }

  syncClips(clips: Clip[]): void {
    const msg: PreviewWorkerInbound = {
      type: 'sync-clips',
      clips: clips.map(toWorkerClip),
    };
    this.worker.postMessage(msg);
  }

  pauseDecoders(): void {
    const msg: PreviewWorkerInbound = { type: 'pause-decoders' };
    this.worker.postMessage(msg);
  }

  destroy(): void {
    const msg: PreviewWorkerInbound = { type: 'destroy' };
    this.worker.postMessage(msg);
    const err = new Error('PreviewWorkerRuntime destroyed');
    for (const pending of this.pendingRenders.values()) pending.reject(err);
    this.pendingRenders.clear();
  }
}

// ---------------------------------------------------------------------------
// PreviewWorkerAdapter — TimelineCompositor wrapper for the worker runtime.
//
// Keeps ClipMediaPool on the main thread for VideoFrame capture, forwards
// all GPU work to the off-thread worker via PreviewWorkerRuntime.
// ---------------------------------------------------------------------------

async function captureVideoFrameFromElement(
  video: HTMLVideoElement,
): Promise<VideoFrame | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  try {
    return new VideoFrame(video);
  } catch {
    return null;
  }
}

async function captureStillVideoFrame(
  img: HTMLImageElement,
): Promise<VideoFrame | null> {
  if (!img.complete || img.naturalWidth <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return new VideoFrame(canvas, { timestamp: 0 });
  } catch {
    return null;
  }
}

/**
 * Implements the TimelineCompositor interface backed by the off-thread worker.
 * Frame capture (seek + VideoFrame) stays on the main thread; GPU compositing
 * runs in the worker on the transferred OffscreenCanvas.
 */
export class PreviewWorkerAdapter implements TimelineCompositor {
  private readonly runtime: PreviewWorkerRuntime;
  private readonly pool: ClipMediaPool;

  private constructor(runtime: PreviewWorkerRuntime, pool: ClipMediaPool) {
    this.runtime = runtime;
    this.pool = pool;
  }

  /**
   * Create a worker-backed compositor.  Transfers canvas control to the worker.
   * Returns null if OffscreenCanvas or WebGPU is unavailable in the worker.
   */
  static async create(
    canvas: HTMLCanvasElement,
    _clips: Clip[],
  ): Promise<PreviewWorkerAdapter | null> {
    const runtime = await PreviewWorkerRuntime.create(canvas);
    if (!runtime) return null;
    return new PreviewWorkerAdapter(runtime, new ClipMediaPool());
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
    const captureFrames: FrameCaptureCallback = async (requests) => {
      const captured: CapturedFrame[] = [];

      for (const req of requests) {
        if (options?.isCancelled?.()) break;

        // RIFE morph segment — keyed by mediaObjectUrl.
        if (req.mediaObjectUrl) {
          const video = this.pool.getVideoForUrl(req.clipId, req.mediaObjectUrl);
          const seekStart = performance.now();
          await seekVideoTo(video, req.sourceTime);
          previewMetrics.recordSeek(performance.now() - seekStart);
          if (options?.isCancelled?.()) break;
          const frame = await captureVideoFrameFromElement(video);
          if (frame) {
            captured.push({
              clipId: req.clipId,
              role: req.role,
              frame,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
            });
          }
          continue;
        }

        const clip = clips.find((c) => c.id === req.clipId);
        if (!clip) continue;

        if (clip.stillImage) {
          const img = this.pool.getStillImage(clip);
          if (!img.complete) {
            await new Promise<void>((resolve) => {
              img.onload = () => resolve();
              img.onerror = () => resolve();
            });
          }
          if (options?.isCancelled?.()) break;
          const frame = await captureStillVideoFrame(img);
          if (frame) {
            captured.push({
              clipId: req.clipId,
              role: req.role,
              frame,
              videoWidth: img.naturalWidth,
              videoHeight: img.naturalHeight,
            });
          }
          continue;
        }

        if (clip.kind !== 'video') continue;

        const video = this.pool.getVideo(clip);
        const seekStart = performance.now();
        await seekVideoTo(video, req.sourceTime);
        previewMetrics.recordSeek(performance.now() - seekStart);
        if (options?.isCancelled?.()) break;
        const frame = await captureVideoFrameFromElement(video);
        if (frame) {
          captured.push({
            clipId: req.clipId,
            role: req.role,
            frame,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          });
        }
      }

      return captured;
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
        colorGrade: options?.colorGrade,
      },
      captureFrames,
    );

    if (!plan) {
      // Render was cancelled — throw so the caller's catch block handles it.
      // The caller checks isCancelled() first, so this won't count as a failure.
      throw new Error('render cancelled');
    }

    return plan;
  }

  syncClips(clips: Clip[]): void {
    this.pool.pruneExcept(new Set(clips.map((c) => c.id)));
    previewMetrics.setDecoderCount(this.pool.size, this.pool.limit);
  }

  pauseDecoders(): void {
    this.pool.pauseAll();
  }

  destroy(): void {
    this.pool.destroy();
    this.runtime.destroy();
  }
}
