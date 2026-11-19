/**
 * Off-thread WebGPU preview worker.
 *
 * Owns the PreviewEngine on a transferred OffscreenCanvas, served through
 * the worker RPC (protocol: `previewWorkerProtocol.ts`). Per-frame flow:
 *   1. Main calls 'render' with clips + globalTime.
 *   2. Worker runs buildPreviewCompositionPlan (pure math, no DOM).
 *   3. Worker decodes what it can itself (PreviewDecoderSource — same
 *      `VideoDecoder` + ring buffer + forward cursor as GPU export).
 *   4. Only layers the decoder cannot serve (stills, RIFE morph segments,
 *      media that fails to open) go back to main as 'need-frames' → 'frames-ready'.
 *   5. Worker renders layers to OffscreenCanvas and answers the call, then
 *      emits 'scopes' when waveform/vectorscope are enabled.
 *
 * Startup is two-phase: probe GPU first (no canvas), then accept the
 * transferred OffscreenCanvas only after main sees webgpuAvailable: true.
 * A failed probe never starts a Canvas2D compositor as if GPU succeeded.
 */

import type { Clip } from '../types';
import { withNestedInstances } from '../composition/nestedSequences';
import type { FinishingSettings } from '../finishing/finishing';
import type { ColorManagementSettings } from '../finishing/colorManagement';
import { getColorDebugSnapshot } from '../finishing/colorManagement';
import { resolveTimelineFinishing } from '../finishing/finishing';
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
} from '../composition/previewComposition';
import {
  allowFallbackAdapterForPreview,
  onGpuDeviceLost,
  onGpuDeviceRecovered,
  onGpuDeviceRecoveryFailed,
  onGpuError,
  peekGpuDevice,
} from './gpuDevice';
import { getGpuProfileSnapshot, isGpuProfilingRequested, requestGpuProfiling } from './gpuProfiler';
import { probeWebGpu, type WebGpuProbeResult } from './webgpuProbe';
import { adoptGpuDevice, peekChoresGpuDevice } from '../gpu-chores/device';
import { runJob } from '../gpu-chores/runJob';
import { closeBitmap } from '../gpu-chores/rasterize';
import { VECTORSCOPE_SIZE } from '../gpu-chores/cpu/vectorscope';
import type { GpuChoreResult } from '../gpu-chores/types';
import { WorkerTimelineRenderer, type CapturedFrameEntry } from './workerTimelineRenderer';
import { PreviewDecoderSource } from './previewDecoderSource';
import { WorkerFrameKeys, cacheFrameNumber, snapToCacheGrid } from './previewWorkerCache';
import { PREVIEW_CACHE_FPS } from '../composition/previewCacheGrid';
import { quantizePlan } from '../export/renderKey';
import type {
  CapturedFrame,
  FrameRequest,
  FrameSourceStats,
  PreviewCacheStatusRequest,
  PreviewRenderResult,
  PreviewWorkerProtocol,
  ScopeData,
  ScopeSettings,
  WorkerClip,
} from './previewWorkerProtocol';
import { SCOPES_OFF } from './previewWorkerProtocol';
import type { PreviewMediaSource } from '../media/proxyMedia';
import { exposeWorker, withTransfer, type WorkerHandlers, type WorkerPort } from '../workers/workerRpc';

let renderer: WorkerTimelineRenderer | null = null;
/** Main's `(dynamic-range: high)`, kept for a renderer created after it arrived. */
let displayHdr = false;
let decoderSource: PreviewDecoderSource | null = null;
let scopeSettings: ScopeSettings = SCOPES_OFF;

interface PendingRender {
  plan: PreviewCompositionPlan;
  finishing: FinishingSettings | undefined;
  colorManagement: ColorManagementSettings | undefined;
  /** Frames the worker's own decoder already produced for this render. */
  decoded: CapturedFrame[];
  /** How many of `decoded` were read from a preview proxy. */
  proxyDecoded: number;
  /** RAM preview: store the drawn frame under this key (null = not cached). */
  cacheKey: string | null;
  /** Frame number (30 fps grid) `cacheKey` stands for. */
  cacheFrame: number;
  /** Background fill: present this cached frame again after storing. */
  restoreKey: string | null;
}
/** Renders waiting on main's `frames-ready`, by render id. */
const awaitingFrames = new Map<number, (frames: CapturedFrame[]) => void>();
/** Clip media the worker holds but has not been able to attach yet (pre-init). */
const stagedMedia = new Map<string, { blob: Blob; source: PreviewMediaSource | undefined }>();

type Port = WorkerPort<PreviewWorkerProtocol>;

function choreTransferList(results: GpuChoreResult[]): Transferable[] {
  const transfer: Transferable[] = [];
  for (const result of results) {
    if (result.histogram) transfer.push(result.histogram.buffer);
    if (result.vectorscope) transfer.push(result.vectorscope.buffer);
    if (result.pixels) transfer.push(result.pixels.buffer);
  }
  return transfer;
}

function closeFrames(frames: Array<{ frame: VideoFrame }>): void {
  for (const f of frames) f.frame.close();
}

// This realm's device is invisible to main's registry: forward its health.
// `PreviewEngine` rebuilds itself on recovery, so main only has to wait.
function forwardGpuHealth(port: Port): void {
  onGpuError((entry) => {
    if (entry.type !== 'lost') port.emit('gpu-error', { entry });
  });
  onGpuDeviceLost((info) => {
    port.emit('gpu-lost', { message: info.message, timestamp: Date.now() });
  });
  onGpuDeviceRecovered(() => {
    port.emit('gpu-recovered');
  });
  onGpuDeviceRecoveryFailed((error) => {
    port.emit('gpu-recovery-failed', { message: error.message, timestamp: Date.now() });
  });
}

// Phase-1 probe once main's `configure` arrives (it is the first call) —
// before main transfers the canvas, so a failed probe never neuters the DOM
// canvas.
let probe: Promise<WebGpuProbeResult> | null = null;
async function runProbe(allowFallbackAdapter: boolean): Promise<WebGpuProbeResult> {
  let webgpuProbe: WebGpuProbeResult = await probeWebGpu();
  if (webgpuProbe.ok && webgpuProbe.isFallbackAdapter && !allowFallbackAdapter) {
    // A software adapter would preview at a few frames per second: say so
    // in the hard-fail banner instead of starting it.
    webgpuProbe = { ...webgpuProbe, ok: false, reason: 'software fallback adapter (refused for live preview)' };
  }
  console.info('[webgpuProbe]', webgpuProbe);
  if (webgpuProbe.ok) {
    const device = peekGpuDevice();
    if (device) adoptGpuDevice(device);
  }
  return webgpuProbe;
}

/**
 * Composite `pending` and report completion (null when cancelled). Owns
 * every frame passed in and closes them (directly or via the renderer).
 */
async function completeRender(
  port: Port,
  renderId: number,
  pending: PendingRender,
  elementFrames: CapturedFrame[],
  elementProxyFrames: number,
  cancelled: () => boolean,
): Promise<PreviewRenderResult | null> {
  if (!renderer) {
    closeFrames(pending.decoded);
    closeFrames(elementFrames);
    return null;
  }

  const frameSources: FrameSourceStats = {
    decoder: pending.decoded.length,
    element: elementFrames.length,
    proxy: pending.proxyDecoded + elementProxyFrames,
  };

  const entries: CapturedFrameEntry[] = [...pending.decoded, ...elementFrames].map((f) => ({
    clipId: f.clipId,
    role: f.role,
    frame: f.frame,
    videoWidth: f.videoWidth,
    videoHeight: f.videoHeight,
  }));

  // Resize to match the plan's capped canvas dimensions.
  renderer.resizeCanvas(pending.plan.canvasWidth, pending.plan.canvasHeight);

  await renderer.renderFromFrames(
    pending.plan,
    entries,
    pending.finishing,
    cancelled,
    undefined,
    pending.colorManagement,
  );
  port.emit('color-state', { snapshot: getColorDebugSnapshot() });

  if (cancelled()) return null;

  // RAM preview: keep the frame (only when the worker decoded every layer
  // itself — a `<video>` capture has no key) in the task that drew it.
  let cache: PreviewRenderResult['cache'] = 'off';
  if (pending.cacheKey && elementFrames.length === 0) {
    cache = renderer.storeCachedFrame(pending.cacheKey, pending.cacheFrame) ? 'miss' : 'off';
  }
  if (pending.restoreKey) {
    // Background fill: put the frame being shown back before the canvas presents.
    renderer.presentCachedFrame(pending.restoreKey);
    return { plan: pending.plan, frameSources, cache };
  }

  // Grab the scope copy before yielding — the swapchain texture is only valid
  // in the task that drew it.
  const scopeTexture =
    scopeSettings.waveform || scopeSettings.vectorscope
      ? renderer.captureScopeTexture()
      : null;
  const scopeSize = renderer.scopeTextureSize;

  // Scopes follow the frame's answer; they never hold it up.
  if (scopeTexture) void postScopes(port, renderId, scopeTexture, scopeSize);

  return {
    plan: pending.plan,
    frameSources,
    cache,
    ...(isGpuProfilingRequested() ? { gpuProfile: getGpuProfileSnapshot() } : {}),
  };
}

/** The plan for a preview request at `globalTime` (snapped + quantized when the cache is on). */
function planFor(req: PreviewCacheStatusRequest, globalTime: number, cacheOn: boolean): PreviewCompositionPlan {
  // buildPreviewCompositionPlan is pure math — safe to run in a worker.
  // WorkerClip is Clip with the non-serializable `file` field stripped;
  // the function never reads `.file`.
  const plan = buildPreviewCompositionPlan(
    req.clips as Clip[],
    req.clipGroups,
    req.transitions,
    req.textOverlays,
    req.exportSettings,
    cacheOn ? snapToCacheGrid(globalTime) : globalTime,
    req.maxHeight,
    req.maxWidth,
    {
      ...(req.captions ? { captions: req.captions } : {}),
      ...(req.captionStyle ? { captionStyle: req.captionStyle } : {}),
    },
  );
  return cacheOn ? quantizePlan(plan) : plan;
}

const frameKeys = new WorkerFrameKeys((clipId) => decoderSource?.mediaFor(clipId));

function cacheKeyFor(
  req: PreviewCacheStatusRequest,
  plan: PreviewCompositionPlan,
  finishing: FinishingSettings | undefined,
): string | null {
  const clipsById = new Map<string, Clip>(withNestedInstances(req.clips as Clip[]).map((c) => [c.id, c]));
  return frameKeys.keyFor({ plan, clipsById, finishing, colorManagement: req.colorManagement, displayHdr });
}

function requestFinishing(req: PreviewCacheStatusRequest): FinishingSettings | undefined {
  return resolveTimelineFinishing({
    ...(req.finishing ? { finishing: req.finishing } : {}),
    ...(req.colorGrade ? { colorGrade: req.colorGrade } : {}),
  });
}

/** Run the enabled scope kernels on the composed-frame copy and post the bins. */
async function postScopes(
  port: Port,
  renderId: number,
  texture: GPUTexture,
  size: { width: number; height: number },
): Promise<void> {
  if (!peekChoresGpuDevice()) return;
  if (size.width <= 0 || size.height <= 0) return;
  try {
    const scopes: ScopeData = { width: size.width, height: size.height };
    if (scopeSettings.waveform) {
      const result = await runJob({
        op: 'luma_histogram_bt709',
        prefer: 'webgpu',
        width: size.width,
        height: size.height,
        texture,
      });
      if (result.histogram) scopes.histogram = result.histogram;
    }
    if (scopeSettings.vectorscope) {
      const result = await runJob({
        op: 'vectorscope_uv',
        prefer: 'webgpu',
        width: size.width,
        height: size.height,
        binSize: VECTORSCOPE_SIZE,
        texture,
      });
      if (result.vectorscope) scopes.vectorscope = result.vectorscope;
      if (result.binSize !== undefined) scopes.vectorscopeSize = result.binSize;
    }
    const transfer: Transferable[] = [];
    if (scopes.histogram) transfer.push(scopes.histogram.buffer);
    if (scopes.vectorscope) transfer.push(scopes.vectorscope.buffer);
    port.emit('scopes', { renderId, scopes }, transfer);
  } catch (err) {
    // Scopes are an overlay, never the frame: a failed readback is logged and
    // dropped rather than failing the render.
    console.warn('[preview scopes]', err instanceof Error ? err.message : String(err));
  }
}

/** Resolve with main's `frames-ready` for `renderId`, or null when the render is cancelled first. */
function waitForFrames(renderId: number, signal: AbortSignal): Promise<CapturedFrame[] | null> {
  return new Promise((resolve) => {
    const onAbort = () => {
      awaitingFrames.delete(renderId);
      resolve(null);
    };
    awaitingFrames.set(renderId, (frames) => {
      signal.removeEventListener('abort', onAbort);
      resolve(frames);
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function previewHandlers(port: Port): WorkerHandlers<PreviewWorkerProtocol> {
  forwardGpuHealth(port);
  return {
    configure: async ({ gpuProfile, allowFallbackAdapter }) => {
      requestGpuProfiling(gpuProfile);
      allowFallbackAdapterForPreview(allowFallbackAdapter);
      probe ??= runProbe(allowFallbackAdapter);
      const webgpuProbe = await probe;
      return { webgpuAvailable: webgpuProbe.ok, webgpuProbe };
    },

    init: async ({ canvas, width, height, decoderEnabled }) => {
      try {
        renderer?.destroy();
        renderer = await WorkerTimelineRenderer.create(canvas);
        renderer.setDisplayHdr(displayHdr);
        renderer.resizeCanvas(width, height);
        decoderSource?.destroy();
        decoderSource = decoderEnabled === false ? null : new PreviewDecoderSource();
        if (decoderSource) {
          for (const [clipId, { blob, source }] of stagedMedia) {
            decoderSource.setClipMedia(clipId, blob, source);
          }
        }
        stagedMedia.clear();
      } catch (err) {
        renderer = null;
        throw err;
      }
    },

    render: async (req, ctx) => {
      if (!renderer) return null;
      const cancelled = () => ctx.signal.aborted;
      const { renderId } = req;
      const layerClips = req.clips as Clip[];
      const resolvedFinishing = requestFinishing(req);
      if (cancelled()) return null;

      const cacheOn = req.previewCache === true;
      const plan = planFor(req, req.globalTime, cacheOn);
      const cacheKey = cacheOn ? cacheKeyFor(req, plan, resolvedFinishing) : null;
      let restoreKey: string | null = null;
      if (req.prerender) {
        // Fill only behind a frame we can put back, so nothing flickers.
        restoreKey = cacheKeyFor(req, planFor(req, req.prerender.restoreTime, true), resolvedFinishing);
        if (!cacheKey || !restoreKey || !renderer.hasCachedFrame(restoreKey)) return null;
        if (renderer.hasCachedFrame(cacheKey)) {
          return { plan, frameSources: { decoder: 0, element: 0 }, cache: 'hit' };
        }
      } else if (cacheKey) {
        renderer.resizeCanvas(plan.canvasWidth, plan.canvasHeight);
        if (renderer.presentCachedFrame(cacheKey)) {
          const scopeTexture =
            scopeSettings.waveform || scopeSettings.vectorscope ? renderer.captureScopeTexture() : null;
          if (scopeTexture) void postScopes(port, renderId, scopeTexture, renderer.scopeTextureSize);
          return { plan, frameSources: { decoder: 0, element: 0 }, cache: 'hit' };
        }
      }

      if (cancelled()) return null;

      // Build per-layer frame requests.
      const requests: FrameRequest[] = [];
      for (const layer of plan.layers) {
        if (layer.kind !== 'base' && layer.kind !== 'pip') continue;
        const clipLayer: PreviewClipLayer = layer;
        requests.push({
          clipId: clipLayer.clipId,
          role: clipLayer.crossfade?.role ?? 'base',
          sourceTime: clipLayer.sourceTime,
          ...(clipLayer.mediaObjectUrl ? { mediaObjectUrl: clipLayer.mediaObjectUrl } : {}),
        });
      }

      // Decoder first; only what it can't serve round-trips to the main thread.
      let decoded: CapturedFrame[] = [];
      let proxyDecoded = 0;
      let fallback = requests;
      if (decoderSource) {
        // Nested-sequence layers carry namespaced ids (`withNestedInstances`).
        const clipsById = new Map<string, WorkerClip>(withNestedInstances(layerClips).map((c) => [c.id, c]));
        const split = await decoderSource.split(requests, clipsById);
        decoded = split.decoded;
        proxyDecoded = split.proxyDecoded;
        fallback = split.fallback;
      }

      const pending: PendingRender = {
        plan,
        finishing: resolvedFinishing,
        colorManagement: req.colorManagement,
        decoded,
        proxyDecoded,
        cacheKey,
        cacheFrame: cacheFrameNumber(plan.globalTime),
        restoreKey,
      };

      if (cancelled()) {
        closeFrames(decoded);
        return null;
      }

      if (fallback.length === 0) {
        // Happy path: no <video> seek on the main thread at all.
        return completeRender(port, renderId, pending, [], 0, cancelled);
      }

      const framesReady = waitForFrames(renderId, ctx.signal);
      port.emit('need-frames', { renderId, requests: fallback });
      const frames = await framesReady;
      if (!frames || cancelled() || !renderer) {
        if (frames) closeFrames(frames);
        closeFrames(decoded);
        return null;
      }
      const proxyFrames = frames.reduce((n, f) => n + (f.proxy ? 1 : 0), 0);
      return completeRender(port, renderId, pending, frames, proxyFrames, cancelled);
    },

    'frames-ready': ({ renderId, frames }) => {
      const resolve = awaitingFrames.get(renderId);
      awaitingFrames.delete(renderId);
      // A render cancelled meanwhile no longer wants them.
      if (resolve) resolve(frames);
      else closeFrames(frames);
    },

    'chore-jobs': async ({ jobs, source }) => {
      try {
        const results: GpuChoreResult[] = [];
        for (const spec of jobs) {
          results.push(await runJob(source ? { ...spec, source } : spec));
        }
        return withTransfer(results, choreTransferList(results));
      } finally {
        if (source) closeBitmap(source);
      }
    },

    'cache-status': (req) => {
      if (!renderer) return null;
      const finishing = requestFinishing(req);
      const frames: number[] = [];
      for (const [key, frame] of renderer.cachedFrames()) {
        if (cacheKeyFor(req, planFor(req, frame / PREVIEW_CACHE_FPS, true), finishing) === key) frames.push(frame);
      }
      return { frames, ...renderer.frameCacheStats() };
    },

    'clear-preview-cache': () => {
      renderer?.clearFrameCache();
    },

    'clip-media': ({ media }) => {
      for (const { clipId, blob, source } of media) {
        frameKeys.noteMedia(blob);
        if (decoderSource) decoderSource.setClipMedia(clipId, blob, source);
        else stagedMedia.set(clipId, { blob, source });
      }
    },

    resize: ({ width, height }) => {
      renderer?.resizeCanvas(width, height);
    },

    'reset-finishing': () => {
      renderer?.resetFinishingTemporal();
    },

    'set-scopes': ({ scopes }) => {
      scopeSettings = scopes;
    },

    'display-hdr': ({ hdr }) => {
      displayHdr = hdr;
      renderer?.setDisplayHdr(displayHdr);
    },

    'sync-clips': ({ clips }) => {
      // Ring buffers are sized per *active* layer; media for clips that left
      // the timeline is dropped along with their cursors.
      decoderSource?.pruneExcept(new Set(clips.map((c) => c.id)));
    },

    'pause-decoders': () => {
      decoderSource?.releaseCursors();
    },

    destroy: () => {
      renderer?.destroy();
      renderer = null;
      decoderSource?.destroy();
      decoderSource = null;
      self.close();
    },
  };
}

exposeWorker<PreviewWorkerProtocol>(previewHandlers);
