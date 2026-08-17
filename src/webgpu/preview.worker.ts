/**
 * Off-thread WebGPU preview worker.
 *
 * Owns the PreviewEngine on a transferred OffscreenCanvas.  Per-frame flow:
 *   1. Main sends 'render' with clips + globalTime.
 *   2. Worker runs buildPreviewCompositionPlan (pure math, no DOM).
 *   3. Worker posts 'need-frames' with per-layer seek requests.
 *   4. Main captures VideoFrames from hidden <video> elements and posts 'frames-ready'.
 *   5. Worker renders layers to OffscreenCanvas and posts 'render-complete'.
 *
 * Startup is two-phase: probe GPU first (no canvas), then accept the
 * transferred OffscreenCanvas only after main sees webgpuAvailable: true.
 */

import type { Clip } from '../types';
import type { FinishingSettings } from '../utils/finishing';
import { resolveTimelineFinishing } from '../utils/finishing';
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
} from '../utils/previewComposition';
import { acquireGpuContext } from './gpuDevice';
import { adoptGpuDevice } from '../gpu-chores/device';
import { WorkerTimelineRenderer, type CapturedFrameEntry } from './timelinePreview';
import type { PreviewWorkerInbound, PreviewWorkerOutbound, FrameRequest } from './previewWorkerProtocol';

let renderer: WorkerTimelineRenderer | null = null;

interface PendingRender {
  plan: PreviewCompositionPlan;
  finishing?: FinishingSettings;
}
const pendingRenders = new Map<number, PendingRender>();
const cancelledIds = new Set<number>();

function post(msg: PreviewWorkerOutbound): void {
  self.postMessage(msg);
}

/** Probe WebGPU without touching the display canvas. */
async function probeWebGpu(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    const ctx = await acquireGpuContext();
    adoptGpuDevice(ctx.device);
    return !!ctx.device;
  } catch {
    return false;
  }
}

// Phase-1 probe as soon as the worker module loads — before main transfers
// the canvas — so a failed probe never neuters the DOM canvas.
void probeWebGpu().then((webgpuAvailable) => {
  post({ type: 'ready', webgpuAvailable });
});

self.onmessage = async (event: MessageEvent<PreviewWorkerInbound>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      try {
        renderer?.destroy();
        renderer = await WorkerTimelineRenderer.create(msg.canvas);
        renderer.resizeCanvas(msg.width, msg.height);
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

      pendingRenders.set(renderId, { plan, finishing: resolvedFinishing });
      post({ type: 'need-frames', renderId, requests });
      break;
    }

    case 'frames-ready': {
      if (!renderer) break;

      const { renderId, frames } = msg;
      const pending = pendingRenders.get(renderId);
      pendingRenders.delete(renderId);

      if (!pending || cancelledIds.has(renderId)) {
        cancelledIds.delete(renderId);
        frames.forEach((f) => f.frame.close());
        post({ type: 'render-cancelled', renderId });
        break;
      }

      const entries: CapturedFrameEntry[] = frames.map((f) => ({
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
        break;
      }

      post({ type: 'render-complete', renderId, plan: pending.plan });
      break;
    }

    case 'cancel': {
      cancelledIds.add(msg.renderId);
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

    case 'sync-clips':
    case 'pause-decoders': {
      // Worker has no media pool — no-op.
      break;
    }

    case 'destroy': {
      renderer?.destroy();
      renderer = null;
      self.close();
      break;
    }
  }
};
