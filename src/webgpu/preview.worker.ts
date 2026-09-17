/**
 * Off-thread WebGPU preview worker.
 *
 * Owns the PreviewEngine on a transferred OffscreenCanvas.  Per-frame flow:
 *   1. Main sends 'render' with clips + globalTime.
 *   2. Worker runs buildPreviewCompositionPlan (pure math, no DOM).
 *   3. Worker decodes what it can itself (PreviewDecoderSource — same
 *      `VideoDecoder` + ring buffer + forward cursor as GPU export).
 *   4. Only layers the decoder cannot serve (WebM/alpha, stills, RIFE morph
 *      segments) go back to main as 'need-frames' → 'frames-ready'.
 *   5. Worker renders layers to OffscreenCanvas and posts 'render-complete',
 *      plus 'scopes' when waveform/vectorscope are enabled.
 *
 * Startup is two-phase: probe GPU first (no canvas), then accept the
 * transferred OffscreenCanvas only after main sees webgpuAvailable: true.
 * A failed probe never starts a Canvas2D compositor as if GPU succeeded.
 */

import type { Clip } from '../types';
import type { FinishingSettings } from '../utils/finishing';
import { resolveTimelineFinishing } from '../utils/finishing';
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
} from '../utils/previewComposition';
import { peekGpuDevice } from './gpuDevice';
import { probeWebGpu } from './webgpuProbe';
import { adoptGpuDevice, peekChoresGpuDevice } from '../gpu-chores/device';
import { runJob } from '../gpu-chores/runJob';
import { closeBitmap } from '../gpu-chores/rasterize';
import { VECTORSCOPE_SIZE } from '../gpu-chores/cpu/vectorscope';
import type { GpuChoreResult } from '../gpu-chores/types';
import { WorkerTimelineRenderer, type CapturedFrameEntry } from './timelinePreview';
import { PreviewDecoderSource } from './previewDecoderSource';
import type {
  CapturedFrame,
  FrameRequest,
  FrameSourceStats,
  PreviewWorkerInbound,
  PreviewWorkerOutbound,
  ScopeData,
  ScopeSettings,
  WorkerClip,
} from './previewWorkerProtocol';
import { SCOPES_OFF } from './previewWorkerProtocol';

let renderer: WorkerTimelineRenderer | null = null;
let decoderSource: PreviewDecoderSource | null = null;
let scopeSettings: ScopeSettings = SCOPES_OFF;

interface PendingRender {
  plan: PreviewCompositionPlan;
  finishing?: FinishingSettings;
  /** Frames the worker's own decoder already produced for this render. */
  decoded: CapturedFrame[];
}
const pendingRenders = new Map<number, PendingRender>();
const cancelledIds = new Set<number>();
/** Clip media the worker holds but has not been able to attach yet (pre-init). */
const stagedMedia = new Map<string, Blob>();

function post(msg: PreviewWorkerOutbound, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

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

// Phase-1 probe as soon as the worker module loads — before main transfers
// the canvas — so a failed probe never neuters the DOM canvas.
void probeWebGpu().then((webgpuProbe) => {
  console.info('[webgpuProbe]', webgpuProbe);
  if (webgpuProbe.ok) {
    const device = peekGpuDevice();
    if (device) adoptGpuDevice(device);
  }
  post({ type: 'ready', webgpuAvailable: webgpuProbe.ok, webgpuProbe });
});

/**
 * Composite `pending` and report completion. Owns every frame passed in and
 * closes them (directly or via the renderer).
 */
async function completeRender(
  renderId: number,
  pending: PendingRender,
  elementFrames: CapturedFrame[],
): Promise<void> {
  if (!renderer) {
    closeFrames(pending.decoded);
    closeFrames(elementFrames);
    return;
  }

  const frameSources: FrameSourceStats = {
    decoder: pending.decoded.length,
    element: elementFrames.length,
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
    () => cancelledIds.has(renderId),
  );

  if (cancelledIds.has(renderId)) {
    cancelledIds.delete(renderId);
    post({ type: 'render-cancelled', renderId });
    return;
  }

  // Grab the scope copy before yielding — the swapchain texture is only valid
  // in the task that drew it.
  const scopeTexture =
    scopeSettings.waveform || scopeSettings.vectorscope
      ? renderer.captureScopeTexture()
      : null;
  const scopeSize = renderer.scopeTextureSize;

  post({ type: 'render-complete', renderId, plan: pending.plan, frameSources });

  if (scopeTexture) {
    await postScopes(renderId, scopeTexture, scopeSize);
  }
}

/** Run the enabled scope kernels on the composed-frame copy and post the bins. */
async function postScopes(
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
      scopes.histogram = result.histogram;
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
      scopes.vectorscope = result.vectorscope;
      scopes.vectorscopeSize = result.binSize;
    }
    const transfer: Transferable[] = [];
    if (scopes.histogram) transfer.push(scopes.histogram.buffer);
    if (scopes.vectorscope) transfer.push(scopes.vectorscope.buffer);
    post({ type: 'scopes', renderId, scopes }, transfer);
  } catch (err) {
    // Scopes are an overlay, never the frame: a failed readback is logged and
    // dropped rather than failing the render.
    console.warn('[preview scopes]', err instanceof Error ? err.message : String(err));
  }
}

self.onmessage = async (event: MessageEvent<PreviewWorkerInbound>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      try {
        renderer?.destroy();
        renderer = await WorkerTimelineRenderer.create(msg.canvas);
        renderer.resizeCanvas(msg.width, msg.height);
        decoderSource?.destroy();
        decoderSource = msg.decoderEnabled === false ? null : new PreviewDecoderSource();
        if (decoderSource) {
          for (const [clipId, blob] of stagedMedia) decoderSource.setClipMedia(clipId, blob);
        }
        stagedMedia.clear();
        post({ type: 'initialized' });
      } catch (err) {
        renderer = null;
        post({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'clip-media': {
      for (const { clipId, blob } of msg.media) {
        if (decoderSource) decoderSource.setClipMedia(clipId, blob);
        else stagedMedia.set(clipId, blob);
      }
      break;
    }

    case 'render': {
      if (!renderer) break;

      const {
        renderId,
        clips,
        clipGroups,
        transitions,
        textOverlays,
        exportSettings,
        globalTime,
        maxWidth,
        maxHeight,
        finishing,
        colorGrade,
        captions,
        captionStyle,
      } = msg;

      const resolvedFinishing = resolveTimelineFinishing({ finishing, colorGrade });

      if (cancelledIds.has(renderId)) {
        cancelledIds.delete(renderId);
        post({ type: 'render-cancelled', renderId });
        break;
      }

      // buildPreviewCompositionPlan is pure math — safe to run in a worker.
      // WorkerClip is Clip with the non-serializable `file` field stripped;
      // the function never accesses `.file` so the cast is safe.
      const plan = buildPreviewCompositionPlan(
        clips as unknown as Clip[],
        clipGroups,
        transitions,
        textOverlays,
        exportSettings,
        globalTime,
        maxHeight,
        maxWidth,
        { captions, captionStyle },
      );

      if (cancelledIds.has(renderId)) {
        cancelledIds.delete(renderId);
        post({ type: 'render-cancelled', renderId });
        break;
      }

      // Build per-layer frame requests.
      const requests: FrameRequest[] = [];
      for (const layer of plan.layers) {
        if (layer.kind !== 'base' && layer.kind !== 'pip') continue;
        const clipLayer = layer as PreviewClipLayer;
        requests.push({
          clipId: clipLayer.clipId,
          role: clipLayer.crossfade?.role ?? 'base',
          sourceTime: clipLayer.sourceTime,
          mediaObjectUrl: clipLayer.mediaObjectUrl,
        });
      }

      // Decoder first; only what it can't serve round-trips to the main thread.
      let decoded: CapturedFrame[] = [];
      let fallback = requests;
      if (decoderSource) {
        const clipsById = new Map<string, WorkerClip>(clips.map((c) => [c.id, c]));
        const split = await decoderSource.split(requests, clipsById);
        decoded = split.decoded;
        fallback = split.fallback;
      }

      const pending: PendingRender = { plan, finishing: resolvedFinishing, decoded };

      if (cancelledIds.has(renderId)) {
        cancelledIds.delete(renderId);
        closeFrames(decoded);
        post({ type: 'render-cancelled', renderId });
        break;
      }

      if (fallback.length === 0) {
        // Happy path: no <video> seek on the main thread at all.
        await completeRender(renderId, pending, []);
        break;
      }

      pendingRenders.set(renderId, pending);
      post({ type: 'need-frames', renderId, requests: fallback });
      break;
    }

    case 'frames-ready': {
      if (!renderer) break;

      const { renderId, frames } = msg;
      const pending = pendingRenders.get(renderId);
      pendingRenders.delete(renderId);

      if (!pending || cancelledIds.has(renderId)) {
        cancelledIds.delete(renderId);
        closeFrames(frames);
        if (pending) closeFrames(pending.decoded);
        post({ type: 'render-cancelled', renderId });
        break;
      }

      await completeRender(renderId, pending, frames);
      break;
    }

    case 'cancel': {
      cancelledIds.add(msg.renderId);
      const pending = pendingRenders.get(msg.renderId);
      if (pending) closeFrames(pending.decoded);
      pendingRenders.delete(msg.renderId);
      break;
    }

    case 'resize': {
      renderer?.resizeCanvas(msg.width, msg.height);
      break;
    }

    case 'reset-finishing': {
      renderer?.resetFinishingTemporal();
      break;
    }

    case 'set-scopes': {
      scopeSettings = msg.scopes;
      break;
    }

    case 'chore-jobs': {
      try {
        const results: GpuChoreResult[] = [];
        for (const spec of msg.jobs) {
          results.push(
            await runJob({
              ...spec,
              source: msg.source,
            }),
          );
        }
        if (msg.source) closeBitmap(msg.source);
        post(
          { type: 'chore-jobs-result', id: msg.id, ok: true, results },
          choreTransferList(results),
        );
      } catch (err) {
        if (msg.source) closeBitmap(msg.source);
        post({
          type: 'chore-jobs-result',
          id: msg.id,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'sync-clips': {
      // Ring buffers are sized per *active* layer; media for clips that left
      // the timeline is dropped along with their cursors.
      decoderSource?.pruneExcept(new Set(msg.clips.map((c) => c.id)));
      break;
    }

    case 'pause-decoders': {
      decoderSource?.releaseCursors();
      break;
    }

    case 'destroy': {
      renderer?.destroy();
      renderer = null;
      decoderSource?.destroy();
      decoderSource = null;
      self.close();
      break;
    }
  }
};
