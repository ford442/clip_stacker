/**
 * Per-layer draw helpers shared by the two timeline compositors:
 * `TimelinePreviewEngine` (main thread, `timelinePreview.ts`) and
 * `WorkerTimelineRenderer` (preview worker, `workerTimelineRenderer.ts`).
 */

import type { PreviewClipLayer, PreviewCompositionPlan } from '../utils/previewComposition';
import {
  combineLetterboxWithLayerUv,
  computeLetterboxUv,
} from './exportCompositor';
import type { NormalizedDestRect } from './previewLayerUniforms';
import { isRegisteredTransitionType } from './transitions/registry';

export function toNormalizedDestRect(
  rect: PreviewClipLayer['rect'],
  canvasWidth: number,
  canvasHeight: number,
): NormalizedDestRect {
  return {
    x: rect.x / canvasWidth,
    y: rect.y / canvasHeight,
    w: rect.width / canvasWidth,
    h: rect.height / canvasHeight,
  };
}

export function isGpuTransitionPair(
  outgoing: PreviewClipLayer,
  incoming: PreviewClipLayer,
): boolean {
  if (!outgoing.crossfade || !incoming.crossfade) return false;
  if (outgoing.crossfade.role !== 'outgoing' || incoming.crossfade.role !== 'incoming') {
    return false;
  }
  if (outgoing.clipId !== outgoing.crossfade.outgoingClipId) return false;
  if (incoming.clipId !== incoming.crossfade.incomingClipId) return false;
  return isRegisteredTransitionType(outgoing.crossfade.type);
}

export function letterboxForLayer(
  layer: PreviewClipLayer,
  video: HTMLVideoElement,
  frame: VideoFrame,
  plan: PreviewCompositionPlan,
): { uvScale: [number, number]; uvOffset: [number, number] } {
  const destWidth =
    layer.kind === 'pip' ? layer.rect.width : plan.canvasWidth;
  const destHeight =
    layer.kind === 'pip' ? layer.rect.height : plan.canvasHeight;
  const videoWidth = video.videoWidth || frame.displayWidth || destWidth;
  const videoHeight =
    video.videoHeight || frame.displayHeight || destHeight;
  const letterbox = computeLetterboxUv(
    videoWidth,
    videoHeight,
    destWidth,
    destHeight,
  );
  return combineLetterboxWithLayerUv(letterbox, layer.uvScale, layer.uvOffset);
}
