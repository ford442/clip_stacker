/**
 * Main-thread proxy for the off-thread WebGPU preview worker.
 *
 * Transfers OffscreenCanvas to the worker only after a successful GPU probe,
 * then provides a promise-based API for timeline rendering.  Frame capture
 * (seek + VideoFrame) stays on the main thread via a caller-supplied callback;
 * independent media elements are sought in parallel.
 */

import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import type { FinishingSettings } from '../utils/finishing';
import { resolveTimelineFinishing } from '../utils/finishing';
import type { ColorGradeSettings } from '../utils/lut';
import type { PreviewCompositionPlan, TimelineCompositor, TimelineRenderOptions } from '../utils/previewComposition';
import { ClipMediaPool, seekVideoTo } from '../utils/clipMediaPool';
import { previewMetrics } from '../utils/previewMetrics';
import {
  groupFrameRequestsByMedia,
  PREVIEW_WORKER_INIT_TIMEOUT_MS,
  toWorkerClip,
  type CapturedFrame,
  type FrameRequest,
  type PreviewWorkerInbound,
  type PreviewWorkerOutbound,
  type WorkerClip,
} from './previewWorkerProtocol';

export type { FrameRequest, CapturedFrame };

/** True after `transferControlToOffscreen()` — the element can no longer host a context. */
export function isCanvasTransferred(canvas: HTMLCanvasElement): boolean {
  try {
    // Re-assigning width is a no-op on a live canvas but throws InvalidStateError
    // once control has been transferred. Avoid getContext() here — that would
    // lock an unused canvas into a 2D context and block WebGPU fallback.
    const { width } = canvas;
    canvas.width = width;
    return false;
  } catch {
    return true;
  }
}

/**
 * Replace a neutered (transferred) canvas with a fresh element that can host
 * WebGPU / Canvas2D for the main-thread fallback path.
 */
export function replaceTransferredCanvas(oldCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const next = document.createElement('canvas');
  next.className = oldCanvas.className;
  next.width = oldCanvas.width || 1280;
  next.height = oldCanvas.height || 720;
  for (const { name, value } of Array.from(oldCanvas.attributes)) {
    if (name === 'width' || name === 'height' || name === 'class') continue;
    next.setAttribute(name, value);
  }
  oldCanvas.parentElement?.replaceChild(next, oldCanvas);
  return next;
}

export interface RenderTimelineParams {
  clips: WorkerClip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings: Pick<ExportSettings, 'outputResolution'> | undefined;
  globalTime: number;
  maxWidth?: number;
  maxHeight?: number;
  finishing?: FinishingSettings;
  /** @deprecated Prefer `finishing`. */
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class PreviewWorkerRuntime {
  private readonly worker: Worker;
  private nextRenderId = 0;
  private readonly pendingRenders = new Map<number, PendingRender>();
  private lastRenderId = -1;
  private destroyed = false;

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
   * Create the runtime by probing the worker for WebGPU, then transferring
   * canvas control only when the probe succeeds. Returns null if OffscreenCanvas
   * or WebGPU is unavailable — the caller's canvas is left usable for
   * main-thread fallback.
   *
   * If the GPU probe succeeds but compositor init fails after the canvas has
   * already been transferred, returns null and the canvas is neutered. Callers
   * should detect that with `isCanvasTransferred` and swap in a fresh element
   * before attempting the main-thread compositor.
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

    try {
      const webgpuAvailable = await withTimeout(
        new Promise<boolean>((resolve, reject) => {
          const onMessage = (event: MessageEvent<PreviewWorkerOutbound>) => {
            if (event.data.type === 'ready') {
              worker.removeEventListener('message', onMessage);
              resolve(event.data.webgpuAvailable);
            }
          };
          worker.addEventListener('message', onMessage);
          worker.addEventListener(
            'error',
            () => {
              worker.removeEventListener('message', onMessage);
              reject(new Error('Preview worker failed to load'));
            },
            { once: true },
          );
        }),
        PREVIEW_WORKER_INIT_TIMEOUT_MS,
        'Preview worker GPU probe',
      );

      if (!webgpuAvailable) {
        worker.terminate();
        return null;
      }

      // Phase 2 — only transfer after the probe succeeds.
      const offscreen = canvas.transferControlToOffscreen();
      const initMsg: PreviewWorkerInbound = {
        type: 'init',
        canvas: offscreen,
        width: canvas.clientWidth || 1280,
        height: canvas.clientHeight || 720,
      };

      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const onMessage = (event: MessageEvent<PreviewWorkerOutbound>) => {
            if (event.data.type === 'initialized') {
              worker.removeEventListener('message', onMessage);
              worker.onmessage = (e: MessageEvent<PreviewWorkerOutbound>) =>
                runtime.handleMessage(e.data);
              resolve();
            } else if (event.data.type === 'error') {
              worker.removeEventListener('message', onMessage);
              reject(new Error(event.data.message));
            }
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage(initMsg, [offscreen as unknown as Transferable]);
        }),
        PREVIEW_WORKER_INIT_TIMEOUT_MS,
        'Preview worker canvas init',
      );

      return runtime;
    } catch {
      worker.terminate();
      return null;
    }
  }

  private handleMessage(msg: PreviewWorkerOutbound): void {
    switch (msg.type) {
      case 'ready':
      case 'initialized': {
        // Handled during create(); ignored after init.
        break;
      }

      case 'need-frames': {
        const pending = this.pendingRenders.get(msg.renderId);
        if (!pending) break;

        pending
          .captureFrames(msg.requests)
          .then((frames) => {
            if (this.destroyed || !this.pendingRenders.has(msg.renderId)) {
              frames.forEach((f) => f.frame.close());
              return;
            }
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
            const pendingRender = this.pendingRenders.get(msg.renderId);
            if (pendingRender) {
              this.pendingRenders.delete(msg.renderId);
              pendingRender.reject(err instanceof Error ? err : new Error(String(err)));
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
        finishing: resolveTimelineFinishing(params),
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

  resetFinishingTemporal(): void {
    const msg: PreviewWorkerInbound = { type: 'reset-finishing' };
    this.worker.postMessage(msg);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      const msg: PreviewWorkerInbound = { type: 'destroy' };
      this.worker.postMessage(msg);
    } catch {
      // Worker may already be gone.
    }
    this.worker.terminate();
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
   * Create a worker-backed compositor.  Transfers canvas control to the worker
   * only after a successful GPU probe. Returns null if OffscreenCanvas or
   * WebGPU is unavailable — the canvas remains usable for main-thread fallback.
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
    const captureOne = async (req: FrameRequest): Promise<CapturedFrame | null> => {
      if (options?.isCancelled?.()) return null;

      // RIFE morph segment — keyed by mediaObjectUrl.
      if (req.mediaObjectUrl) {
        const video = this.pool.getVideoForUrl(req.clipId, req.mediaObjectUrl);
        const seekStart = performance.now();
        await seekVideoTo(video, req.sourceTime);
        previewMetrics.recordSeek(performance.now() - seekStart);
        if (options?.isCancelled?.()) return null;
        const frame = await captureVideoFrameFromElement(video);
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
        const frame = await captureStillVideoFrame(img);
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

      const video = this.pool.getVideo(clip);
      const seekStart = performance.now();
      await seekVideoTo(video, req.sourceTime);
      previewMetrics.recordSeek(performance.now() - seekStart);
      if (options?.isCancelled?.()) return null;
      const frame = await captureVideoFrameFromElement(video);
      if (!frame) return null;
      return {
        clipId: req.clipId,
        role: req.role,
        frame,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
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
    this.runtime.destroy();
  }
}
