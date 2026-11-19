/**
 * Main-thread proxy for the off-thread WebGPU preview worker, through the
 * worker RPC (protocol: `previewWorkerProtocol.ts`).
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
import type { FinishingSettings } from '../finishing/finishing';
import type { ColorManagementSettings } from '../finishing/colorManagement';
import { publishColorDebugSnapshot } from '../finishing/colorManagement';
import { resolveTimelineFinishing } from '../finishing/finishing';
import type { ColorGradeSettings } from '../finishing/lut';
import type {
  PreviewCompositionPlan,
  PreviewDeviceState,
} from '../composition/previewComposition';
import type { PreviewMediaSource } from '../media/proxyMedia';
import type { GpuChoreJobSpec, GpuChoreResult } from '../gpu-chores/types';
import {
  clearPreviewWorkerChoresRunner,
  setPreviewWorkerChoresRunner,
  type PreviewWorkerChoresRunner,
} from '../gpu-chores/previewWorkerBridge';
import {
  PREVIEW_WORKER_INIT_TIMEOUT_MS,
  toWorkerClip,
  type CapturedFrame,
  type FrameRequest,
  type FrameSourceStats,
  type PreviewCacheStatus,
  type PreviewCacheStatusRequest,
  type PreviewRenderResult,
  type PreviewWorkerProtocol,
  type ScopeData,
  type ScopeSettings,
  type WorkerClip,
} from './previewWorkerProtocol';
import {
  isFallbackAdapterAllowedByPage,
  isGpuProfileRequestedByPage,
  isPreviewDecoderEnabled,
} from './previewDecodeFlags';
import { publishWebGpuProbe } from './webgpuProbe';
import { recordRemoteGpuError } from './gpuDevice';
import { createPreviewWorker } from '../workers/workerFactories';
import { createWorkerClient, type WorkerClient, type WorkerLike } from '../workers/workerRpc';

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

export interface RenderTimelineParams {
  clips: WorkerClip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings: Pick<ExportSettings, 'outputResolution'> | undefined;
  globalTime: number;
  maxWidth?: number | undefined;
  maxHeight?: number | undefined;
  finishing?: FinishingSettings | undefined;
  colorManagement?: ColorManagementSettings | undefined;
  /** @deprecated Prefer `finishing`. */
  colorGrade?: ColorGradeSettings | undefined;
  captions?: CaptionEntry[] | undefined;
  captionStyle?: Partial<TextOverlayStyle> | undefined;
  /** RAM preview on (see `PreviewRenderRequest.previewCache`). */
  previewCache?: boolean | undefined;
  /** Background fill (see `PreviewRenderRequest.prerender`). */
  prerender?: { restoreTime: number } | undefined;
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
  /** Aborting cancels the `render` call (and the frame in the worker). */
  controller: AbortController;
  captureFrames: FrameCaptureCallback;
  /** Set when capture failed: the render rejects with it instead of resolving null. */
  captureError: Error | null;
}

type PreviewClient = WorkerClient<PreviewWorkerProtocol>;

export class PreviewWorkerRuntime {
  private nextRenderId = 0;
  private readonly pendingRenders = new Map<number, PendingRender>();
  private lastRenderId = -1;
  private destroyed = false;
  private choresRunner: PreviewWorkerChoresRunner | null = null;
  private scopesListener: ((scopes: ScopeData) => void) | null = null;
  private lastFrameSources: FrameSourceStats = { decoder: 0, element: 0 };
  private lastGpuProfile: Record<string, number> | null = null;
  private lastCache: NonNullable<PreviewRenderResult['cache']> = 'off';
  private readonly deviceListeners = new Set<
    (state: PreviewDeviceState, message?: string) => void
  >();

  private constructor(private readonly client: PreviewClient) {
    client.on('need-frames', ({ renderId, requests }) => this.captureFor(renderId, requests));
    client.on('scopes', ({ scopes }) => this.scopesListener?.(scopes));
    client.on('color-state', ({ snapshot }) => publishColorDebugSnapshot(snapshot));
    // The worker's device is not main's: record its health for Copy Debug
    // and tell the preview, which must not watch main's registry for it.
    client.on('gpu-error', ({ entry }) => recordRemoteGpuError({ ...entry, realm: 'preview-worker' }));
    client.on('gpu-lost', ({ message, timestamp }) => {
      recordRemoteGpuError({ type: 'lost', message, timestamp, realm: 'preview-worker' });
      this.emitDeviceState('lost', message);
    });
    client.on('gpu-recovered', () => this.emitDeviceState('recovered'));
    client.on('gpu-recovery-failed', ({ message, timestamp }) => {
      recordRemoteGpuError({
        type: 'lost',
        message: `Device recreate failed: ${message}`,
        timestamp,
        realm: 'preview-worker',
      });
      this.emitDeviceState('failed', message);
    });
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
    createWorker: () => WorkerLike = createPreviewWorker,
  ): Promise<PreviewWorkerRuntime | null> {
    if (
      typeof OffscreenCanvas === 'undefined' ||
      typeof canvas.transferControlToOffscreen !== 'function'
    ) {
      return null;
    }

    const client = createWorkerClient<PreviewWorkerProtocol>(createWorker, { name: 'preview' });
    if (!client.start()) return null;
    const runtime = new PreviewWorkerRuntime(client);

    try {
      // Before anything else: the worker's GPU probe waits for these flags.
      const { webgpuProbe } = await client.call(
        'configure',
        { gpuProfile: isGpuProfileRequestedByPage(), allowFallbackAdapter: isFallbackAdapterAllowedByPage() },
        { timeoutMs: PREVIEW_WORKER_INIT_TIMEOUT_MS },
      );

      publishWebGpuProbe('worker', webgpuProbe);

      if (!webgpuProbe.ok) {
        client.terminate();
        return null;
      }

      // Phase 2 — only transfer after the probe succeeds.
      const offscreen = canvas.transferControlToOffscreen();
      await client.call(
        'init',
        {
          canvas: offscreen,
          width: canvas.clientWidth || 1280,
          height: canvas.clientHeight || 720,
          decoderEnabled,
        },
        { transfer: [offscreen], timeoutMs: PREVIEW_WORKER_INIT_TIMEOUT_MS },
      );

      runtime.registerChoresRunner();
      return runtime;
    } catch {
      client.terminate();
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

  /** Answer the worker's `need-frames` with `frames-ready` (frames transferred). */
  private captureFor(renderId: number, requests: FrameRequest[]): void {
    const pending = this.pendingRenders.get(renderId);
    if (!pending) return;
    pending
      .captureFrames(requests)
      .then((frames) => {
        if (this.destroyed || this.pendingRenders.get(renderId) !== pending) {
          frames.forEach((f) => f.frame.close());
          return;
        }
        // VideoFrame is Transferable — transfer ownership to worker.
        this.client.notify('frames-ready', { renderId, frames }, { transfer: frames.map((f) => f.frame) });
      })
      .catch((err: unknown) => {
        if (this.pendingRenders.get(renderId) !== pending) return;
        pending.captureError = err instanceof Error ? err : new Error(String(err));
        pending.controller.abort(pending.captureError);
      });
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
   * or null if the render was cancelled (or superseded) before it completed.
   */
  async renderTimeline(
    params: RenderTimelineParams,
    captureFrames: FrameCaptureCallback,
  ): Promise<PreviewCompositionPlan | null> {
    // Cancel any in-flight render — only the latest frame matters.
    if (this.lastRenderId >= 0) this.cancel(this.lastRenderId);

    const renderId = ++this.nextRenderId;
    this.lastRenderId = renderId;
    const pending: PendingRender = { controller: new AbortController(), captureFrames, captureError: null };
    this.pendingRenders.set(renderId, pending);

    try {
      const result = await this.client.call(
        'render',
        {
          renderId,
          clips: params.clips,
          clipGroups: params.clipGroups,
          transitions: params.transitions,
          textOverlays: params.textOverlays,
          exportSettings: params.exportSettings,
          globalTime: params.globalTime,
          maxWidth: params.maxWidth,
          maxHeight: params.maxHeight,
          finishing: resolveTimelineFinishing({
            ...(params.finishing ? { finishing: params.finishing } : {}),
            ...(params.colorGrade ? { colorGrade: params.colorGrade } : {}),
          }),
          colorManagement: params.colorManagement,
          captions: params.captions,
          captionStyle: params.captionStyle,
          previewCache: params.previewCache,
          prerender: params.prerender,
        },
        { signal: pending.controller.signal },
      );
      if (!result) return null;
      this.lastCache = result.cache ?? 'off';
      this.lastFrameSources = result.frameSources;
      if (result.gpuProfile) this.lastGpuProfile = result.gpuProfile;
      return result.plan;
    } catch (err) {
      if (pending.captureError) throw pending.captureError;
      if (pending.controller.signal.aborted) return null;
      throw err;
    } finally {
      if (this.pendingRenders.get(renderId) === pending) this.pendingRenders.delete(renderId);
    }
  }

  /**
   * Run gpu-chores kernels on the preview worker's adopted GPUDevice.
   * Transfers `source`. Independent of the per-frame render queue.
   */
  runChoreJobs(jobs: GpuChoreJobSpec[], source: ImageBitmap): Promise<GpuChoreResult[]> {
    if (this.destroyed) return Promise.reject(new Error('PreviewWorkerRuntime destroyed'));
    return this.client.call('chore-jobs', { jobs, source }, { transfer: [source] });
  }

  /**
   * How the last completed frame's layers were sourced. `element > 0` means
   * the main thread had to seek a hidden `<video>` for that many layers.
   */
  get frameSources(): FrameSourceStats {
    return this.lastFrameSources;
  }

  /** How the last completed frame used the RAM preview. */
  get cacheResult(): NonNullable<PreviewRenderResult['cache']> {
    return this.lastCache;
  }

  /** Which frames of the timeline `req` describes are in the worker's RAM preview. */
  async cacheStatus(req: PreviewCacheStatusRequest): Promise<PreviewCacheStatus | null> {
    if (this.destroyed) return null;
    return this.client.call('cache-status', req);
  }

  clearPreviewCache(): void {
    if (this.destroyed) return;
    this.client.notify('clear-preview-cache');
  }

  /** `?gpu_profile`: the worker's latest per-pass GPU averages (null when off). */
  get gpuProfile(): Record<string, number> | null {
    return this.lastGpuProfile;
  }

  /** Hand the worker the preview bytes (proxy or original) for clips it should decode itself. */
  sendClipMedia(media: Array<{ clipId: string; blob: Blob; source?: PreviewMediaSource }>): void {
    if (this.destroyed || media.length === 0) return;
    this.client.notify('clip-media', { media });
  }

  /** Enable/disable scope computation and subscribe to the per-frame bins. */
  setScopes(scopes: ScopeSettings, listener?: (data: ScopeData) => void): void {
    if (this.destroyed) return;
    if (listener) this.scopesListener = listener;
    else if (!scopes.waveform && !scopes.vectorscope) this.scopesListener = null;
    this.client.notify('set-scopes', { scopes });
  }

  /** Tell the worker whether the page's display is HDR (`(dynamic-range: high)`). */
  setDisplayHdr(hdr: boolean): void {
    if (this.destroyed) return;
    this.client.notify('display-hdr', { hdr });
  }

  /** Cancel one render: its promise resolves null and the worker drops the frame. */
  cancel(renderId: number): void {
    const pending = this.pendingRenders.get(renderId);
    if (!pending) return;
    this.pendingRenders.delete(renderId);
    pending.controller.abort();
  }

  resize(width: number, height: number): void {
    this.client.notify('resize', { width, height });
  }

  syncClips(clips: Clip[]): void {
    this.client.notify('sync-clips', { clips: clips.map(toWorkerClip) });
  }

  pauseDecoders(): void {
    this.client.notify('pause-decoders');
  }

  resetFinishingTemporal(): void {
    this.client.notify('reset-finishing');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.client.notify('destroy');
    } catch {
      // Worker may already be gone.
    }
    // Rejects every pending render and chore job (WorkerCrashedError).
    this.client.terminate();
    this.pendingRenders.clear();
    if (this.choresRunner) {
      clearPreviewWorkerChoresRunner(this.choresRunner);
      this.choresRunner = null;
    }
  }
}
