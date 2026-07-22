/**
 * Off-thread WebGPU preview worker.
 *
 * Owns the PreviewEngine on a transferred OffscreenCanvas.  Per-frame flow:
 *   1. Main sends 'render' with clips + globalTime.
 *   2. Worker runs buildPreviewCompositionPlan (pure math, no DOM).
 *   3. Worker posts 'need-frames' with per-layer seek requests.
 *   4. Main captures VideoFrames from hidden <video> elements and posts 'frames-ready'.
 *   5. Worker renders layers to OffscreenCanvas and posts 'render-complete'.
 */

import type { Clip } from '../types';
import type { ColorGradeSettings } from '../utils/lut';
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
} from '../utils/previewComposition';
import { WorkerTimelineRenderer, type CapturedFrameEntry } from './timelinePreview';
import type { PreviewWorkerInbound, PreviewWorkerOutbound, FrameRequest } from './previewWorkerProtocol';

let renderer: WorkerTimelineRenderer | null = null;

interface PendingRender {
  plan: PreviewCompositionPlan;
  colorGrade?: ColorGradeSettings;
}
const pendingRenders = new Map<number, PendingRender>();
const cancelledIds = new Set<number>();

function post(msg: PreviewWorkerOutbound): void {
  self.postMessage(msg);
}

self.onmessage = async (event: MessageEvent<PreviewWorkerInbound>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      try {
        renderer = await WorkerTimelineRenderer.create(msg.canvas);
        renderer.resizeCanvas(msg.width, msg.height);
        post({ type: 'ready', webgpuAvailable: true });
      } catch {
        post({ type: 'ready', webgpuAvailable: false });
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
        colorGrade,
      } = msg;

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

      pendingRenders.set(renderId, { plan, colorGrade });
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
        pending.colorGrade,
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
