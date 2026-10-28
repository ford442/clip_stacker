/**
 * Main-thread proxy for the off-thread WebGPU preview worker.
 *
 * Transfers OffscreenCanvas to the worker only after a successful GPU probe,
 * then provides a promise-based API for timeline rendering.  Frame capture
 * (seek + VideoFrame) stays on the main thread via a caller-supplied callback;
 * independent media elements are sought in parallel.
 *
 * `PreviewWorkerAdapter` (`previewWorkerAdapter.ts`) wraps this runtime as the
 * preview's `TimelineCompositor`.
 */

import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  TextOverlayStyle,
} from '../types';
import type { FinishingSettings } from '../utils/finishing';
import type { ColorManagementSettings } from '../utils/colorManagement';
import { publishColorDebugSnapshot } from '../utils/colorManagement';
import { resolveTimelineFinishing } from '../utils/finishing';
import type { ColorGradeSettings } from '../utils/lut';
import type {
  PreviewCompositionPlan,
  PreviewDeviceState,
} from '../utils/previewComposition';
import type { PreviewMediaSource } from '../utils/proxyMedia';
import type { GpuChoreJobSpec, GpuChoreResult } from '../gpu-chores/types';
import {
  clearPreviewWorkerChoresRunner,
  setPreviewWorkerChoresRunner,
  type PreviewWorkerChoresRunner,
} from '../gpu-chores/previewWorkerBridge';
import {
  PREVIEW_WORKER_INIT_TIMEOUT_MS,
  SCOPES_OFF,
  toWorkerClip,
  type CapturedFrame,
  type FrameRequest,
  type FrameSourceStats,
  type PreviewWorkerInbound,
  type PreviewWorkerOutbound,
  type ScopeData,
  type ScopeSettings,
  type WorkerClip,
} from './previewWorkerProtocol';
import { isPreviewDecoderEnabled } from './previewDecodeFlags';
import { publishWebGpuProbe, type WebGpuProbeResult } from './webgpuProbe';
import { recordRemoteGpuError } from './gpuDevice';

export type { FrameRequest, CapturedFrame, ScopeData, ScopeSettings };

/** True after `transferControlToOffscreen()` — the element can no longer host a context. */
export function isCanvasTransferred(canvas: HTMLCanvasElement): boolean {
  try {
    // Re-assigning width is a no-op on a live canvas but throws InvalidStateError
    // once control has been transferred. Avoid getContext() here — that would
    // lock an unused canvas into a 2D context and block a later WebGPU bind.
    const { width } = canvas;
    canvas.width = width;
    return false;
  } catch {
    return true;
  }
}

/**
 * Replace a neutered (transferred) canvas with a fresh element that can host
 * WebGPU (or a labeled layer-budget Canvas2D compositor — not a GPU fallback).
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
  colorManagement?: ColorManagementSettings;
  /** @deprecated Prefer `finishing`. */
  colorGrade?: ColorGradeSettings;
  captions?: CaptionEntry[];
  captionStyle?: Partial<TextOverlayStyle>;
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

interface PendingChore {
  resolve: (results: GpuChoreResult[]) => void;
  reject: (err: Error) => void;
}

export class PreviewWorkerRuntime {
  private readonly worker: Worker;
  private nextRenderId = 0;
  private nextChoreId = 0;
  private readonly pendingRenders = new Map<number, PendingRender>();
  private readonly pendingChores = new Map<number, PendingChore>();
  private lastRenderId = -1;
  private destroyed = false;
  private choresRunner: PreviewWorkerChoresRunner | null = null;
  private scopesListener: ((scopes: ScopeData) => void) | null = null;
  private lastFrameSources: FrameSourceStats = { decoder: 0, element: 0 };
  private readonly deviceListeners = new Set<
    (state: PreviewDeviceState, message?: string) => void
  >();

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<PreviewWorkerOutbound>) =>
      this.handleMessage(event.data);
    worker.onerror = (event) => {
      const err = new Error(event.message ?? 'PreviewWorker error');
      for (const pending of this.pendingRenders.values()) pending.reject(err);
      this.pendingRenders.clear();
      for (const pending of this.pendingChores.values()) pending.reject(err);
      this.pendingChores.clear();
    };
  }

  /**
   * Create the runtime by probing the worker for WebGPU, then transferring
   * canvas control only when the probe succeeds. Returns null if OffscreenCanvas
   * is missing or the worker probe failed — the canvas is not transferred.
   * A failed GPU probe is a hard-fail (no Canvas2D stand-in).
   *
   * If the GPU probe succeeds but compositor init fails after the canvas has
   * already been transferred, returns null and the canvas is neutered. Callers
   * should detect that with `isCanvasTransferred` and swap in a fresh element
   * before attempting main-thread WebGPU (only when the worker probe was ok).
   */
  static async create(
    canvas: HTMLCanvasElement,
    decoderEnabled: boolean = isPreviewDecoderEnabled(),
  ): Promise<PreviewWorkerRuntime | null> {
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
      const webgpuProbe = await withTimeout(
        new Promise<WebGpuProbeResult>((resolve, reject) => {
          const onMessage = (event: MessageEvent<PreviewWorkerOutbound>) => {
            if (event.data.type === 'ready') {
              worker.removeEventListener('message', onMessage);
              resolve(event.data.webgpuProbe);
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

      publishWebGpuProbe('worker', webgpuProbe);

      if (!webgpuProbe.ok) {
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
        decoderEnabled,
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

      runtime.registerChoresRunner();
      return runtime;
    } catch {
      worker.terminate();
      return null;
    }
  }

  private registerChoresRunner(): void {
    const runner: PreviewWorkerChoresRunner = {
      runJobs: (jobs, source) => this.runChoreJobs(jobs, source),
    };
    this.choresRunner = runner;
    setPreviewWorkerChoresRunner(runner);
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
        if (msg.frameSources) this.lastFrameSources = msg.frameSources;
        pending?.resolve(msg.plan);
        break;
      }

      case 'scopes': {
        this.scopesListener?.(msg.scopes);
        break;
      }

      case 'color-state': {
        publishColorDebugSnapshot(msg.snapshot);
        break;
      }

      // The worker's device is not main's: record its health for Copy Debug
      // and tell the preview, which must not watch main's registry for it.
      case 'gpu-error': {
        recordRemoteGpuError({ ...msg.entry, realm: 'preview-worker' });
        break;
      }

      case 'gpu-lost': {
        recordRemoteGpuError({
          type: 'lost',
          message: msg.message,
          timestamp: msg.timestamp,
          realm: 'preview-worker',
        });
        this.emitDeviceState('lost', msg.message);
        break;
      }

      case 'gpu-recovered': {
        this.emitDeviceState('recovered');
        break;
      }

      case 'gpu-recovery-failed': {
        recordRemoteGpuError({
          type: 'lost',
          message: `Device recreate failed: ${msg.message}`,
          timestamp: msg.timestamp,
          realm: 'preview-worker',
        });
        this.emitDeviceState('failed', msg.message);
        break;
      }

      case 'render-cancelled': {
        const pending = this.pendingRenders.get(msg.renderId);
        this.pendingRenders.delete(msg.renderId);
        pending?.resolve(null);
        break;
      }

      case 'chore-jobs-result': {
        const pending = this.pendingChores.get(msg.id);
        this.pendingChores.delete(msg.id);
        if (!pending) break;
        if (msg.ok) pending.resolve(msg.results);
        else pending.reject(new Error(msg.message));
        break;
      }

      case 'error': {
        console.error('[PreviewWorker]', msg.message);
        const err = new Error(msg.message);
        for (const pending of this.pendingRenders.values()) pending.reject(err);
        this.pendingRenders.clear();
        for (const pending of this.pendingChores.values()) pending.reject(err);
        this.pendingChores.clear();
        break;
      }
    }
  }

  private emitDeviceState(state: PreviewDeviceState, message?: string): void {
    for (const listener of this.deviceListeners) listener(state, message);
  }

  /** Follow the worker device's loss / recovery. Returns unsubscribe. */
  onDeviceState(listener: (state: PreviewDeviceState, message?: string) => void): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
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
        colorManagement: params.colorManagement,
        captions: params.captions,
        captionStyle: params.captionStyle,
      };
      this.worker.postMessage(renderMsg);
    });
  }

  /**
   * Run gpu-chores kernels on the preview worker's adopted GPUDevice.
   * Transfers `source`. Independent of the per-frame render queue.
   */
  runChoreJobs(jobs: GpuChoreJobSpec[], source: ImageBitmap): Promise<GpuChoreResult[]> {
    if (this.destroyed) return Promise.reject(new Error('PreviewWorkerRuntime destroyed'));
    const id = ++this.nextChoreId;
    return new Promise((resolve, reject) => {
      this.pendingChores.set(id, { resolve, reject });
      const msg: PreviewWorkerInbound = { type: 'chore-jobs', id, jobs, source };
      this.worker.postMessage(msg, [source]);
    });
  }

  /**
   * How the last completed frame's layers were sourced. `element > 0` means
   * the main thread had to seek a hidden `<video>` for that many layers.
   */
  get frameSources(): FrameSourceStats {
    return this.lastFrameSources;
  }

  /** Hand the worker the preview bytes (proxy or original) for clips it should decode itself. */
  sendClipMedia(media: Array<{ clipId: string; blob: Blob; source?: PreviewMediaSource }>): void {
    if (this.destroyed || media.length === 0) return;
    const msg: PreviewWorkerInbound = { type: 'clip-media', media };
    this.worker.postMessage(msg);
  }

  /** Enable/disable scope computation and subscribe to the per-frame bins. */
  setScopes(scopes: ScopeSettings, listener?: (data: ScopeData) => void): void {
    if (this.destroyed) return;
    if (listener) this.scopesListener = listener;
    else if (!scopes.waveform && !scopes.vectorscope) this.scopesListener = null;
    const msg: PreviewWorkerInbound = { type: 'set-scopes', scopes };
    this.worker.postMessage(msg);
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
    for (const pending of this.pendingChores.values()) pending.reject(err);
    this.pendingChores.clear();
    if (this.choresRunner) {
      clearPreviewWorkerChoresRunner(this.choresRunner);
      this.choresRunner = null;
    }
  }
}
