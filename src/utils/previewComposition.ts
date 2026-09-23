/**
 * Pure composition planner: map global timeline time → ordered draw layers.
 *
 * `buildPreviewCompositionPlan` is the single entry point every preview
 * backend (WebGPU `TimelinePreviewEngine`, Canvas2D `TimelineCanvas2DRenderer`)
 * and export path (WebCodecs timeline export, audio schedule) drives through.
 * The implementation is split across sibling modules purely to keep each
 * file under the repo's ~700-line convention — this file re-exports their
 * public surface so every existing `from './previewComposition'` import
 * keeps working unchanged:
 *
 *   - `previewCompositionTypes.ts`    — layer/plan/geometry types
 *   - `previewCompositionSegments.ts` — timeline segment scheduling + rects
 *   - `previewCompositionLayers.ts`   — clip layer construction (crossfades,
 *                                       morph transitions, PiP/overlay lanes)
 *   - `previewCompositionOverlays.ts` — text overlay + caption cue layers
 */

import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import { getClipDuration } from './project';
import { computeTotalDuration } from './transitions';
import { getTimelineClips } from './timelineClips';
import { placementWindow } from './trackStacking';
import { DEFAULT_PREVIEW_MAX_HEIGHT } from './previewBudget';

import {
  buildClipTimelineSegments,
  filterBaseLayerTransitions,
  isBaseClip,
  resolveCanvasSize,
} from './previewCompositionSegments';
import { buildPipLayers, collectScheduledClipLayers } from './previewCompositionLayers';
import { buildCaptionLayers, buildTextLayers } from './previewCompositionOverlays';
import type { CaptionPlanOptions, PreviewCompositionPlan } from './previewCompositionTypes';

export type {
  PreviewLayerKind,
  PreviewPipRect,
  PreviewTransitionCrossfade,
  PreviewClipLayer,
  PreviewTextLayer,
  PreviewCaptionLayer,
  PreviewCompositionLayer,
  LayerFrameProvider,
  TimelineRenderOptions,
  CaptionPlanOptions,
  PreviewCompositionPlan,
  TimelineCompositor,
} from './previewCompositionTypes';
export { captionPlanOptions } from './previewCompositionTypes';

export type { CanvasSizeOptions } from './previewCompositionSegments';
export { buildClipTimelineSegments, filterBaseLayerTransitions } from './previewCompositionSegments';

/**
 * Pure composition planner: map global timeline time → ordered draw layers.
 */
export function buildPreviewCompositionPlan(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  overlays: TextOverlay[],
  settings: Pick<ExportSettings, 'outputResolution'> | undefined,
  globalTime: number,
  maxHeight: number = DEFAULT_PREVIEW_MAX_HEIGHT,
  maxWidth?: number,
  captionOptions?: CaptionPlanOptions,
): PreviewCompositionPlan {
  const timelineClips = getTimelineClips(clips, groups);
  const geom = resolveCanvasSize(settings, { maxHeight, maxWidth });
  const { canvasWidth, canvasHeight, scale, capped } = geom;
  const captions = captionOptions?.captions ?? [];
  const isEmpty =
    timelineClips.length === 0 && overlays.length === 0 && captions.length === 0;

  const pipClips = timelineClips
    .map((clip, timelineIndex) => ({ clip, timelineIndex }))
    .filter(({ clip }) => !isBaseClip(clip));
  const baseClips = timelineClips.filter(isBaseClip);
  const baseTimelineIndices = timelineClips
    .map((clip, timelineIndex) => ({ clip, timelineIndex }))
    .filter(({ clip }) => isBaseClip(clip))
    .map(({ timelineIndex }) => timelineIndex);

  const hasPip = pipClips.length > 0;
  const scheduleClips = hasPip ? baseClips : timelineClips;
  const scheduleTimelineIndices = hasPip
    ? baseTimelineIndices
    : timelineClips.map((_, index) => index);
  const scheduleTransitions = hasPip
    ? filterBaseLayerTransitions(timelineClips, transitions)
    : transitions;

  // Overlay lanes extend the output when they are placed past the base
  // sequence's end — an overlay at t=5s over a 3s base yields an 8s output
  // rather than being clipped away (Phase B: startTime is the output time).
  const baseDuration = computeTotalDuration(scheduleClips, scheduleTransitions);
  const totalDuration = pipClips.reduce((max, { clip }) => {
    const { end } = placementWindow(clip, getClipDuration(clip));
    return Math.max(max, end);
  }, baseDuration);
  const segments = buildClipTimelineSegments(
    scheduleClips,
    scheduleTransitions,
    scheduleTimelineIndices,
  );

  if (isEmpty || globalTime < 0 || (totalDuration > 0 && globalTime > totalDuration)) {
    return {
      globalTime,
      totalDuration,
      canvasWidth,
      canvasHeight,
      scale,
      capped,
      layers: [],
      isEmpty,
    };
  }

  const clipLayers = [
    ...collectScheduledClipLayers(
      segments,
      scheduleTransitions,
      globalTime,
      geom,
    ),
    ...buildPipLayers(pipClips, globalTime, totalDuration, geom),
  ];

  const textLayers = buildTextLayers(overlays, globalTime, totalDuration, geom);
  const captionLayers = buildCaptionLayers(
    captions,
    captionOptions?.captionStyle,
    globalTime,
    geom,
  );

  const layers = [...clipLayers, ...textLayers, ...captionLayers].sort(
    (a, b) => a.zIndex - b.zIndex,
  );

  return {
    globalTime,
    totalDuration,
    canvasWidth,
    canvasHeight,
    scale,
    capped,
    layers,
    isEmpty,
  };
}

/** Local clip time (seconds) at a global output-timeline position. */
export function resolveClipLocalTimeAtGlobal(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  clipId: string,
  globalTime: number,
): { localTime: number; duration: number } | null {
  const timelineClips = getTimelineClips(clips, groups);
  const clip = timelineClips.find((item) => item.id === clipId);
  if (!clip) return null;

  const duration = getClipDuration(clip);
  if ((clip.layerIndex ?? 0) > 0) {
    // Overlay lanes are placed at their track item's output time (Phase B).
    const { start } = placementWindow(clip, duration);
    const localTime = Math.min(
      Math.max(0, globalTime - start),
      Math.max(0, duration - 1e-6),
    );
    return { localTime, duration };
  }

  const baseClips = timelineClips.filter(isBaseClip);
  const baseTimelineIndices = timelineClips
    .map((item, timelineIndex) => ({ item, timelineIndex }))
    .filter(({ item }) => isBaseClip(item))
    .map(({ timelineIndex }) => timelineIndex);
  const pipClips = timelineClips.filter((item) => !isBaseClip(item));
  const hasPip = pipClips.length > 0;
  const scheduleClips = hasPip ? baseClips : timelineClips;
  const scheduleTimelineIndices = hasPip
    ? baseTimelineIndices
    : timelineClips.map((_, index) => index);
  const scheduleTransitions = hasPip
    ? filterBaseLayerTransitions(timelineClips, transitions)
    : transitions;

  const segments = buildClipTimelineSegments(
    scheduleClips,
    scheduleTransitions,
    scheduleTimelineIndices,
  );
  const segment = segments.find((item) => item.clip.id === clipId);
  if (!segment) return null;
  if (globalTime < segment.startTime || globalTime >= segment.endTime) {
    return { localTime: 0, duration };
  }
  return { localTime: globalTime - segment.startTime, duration };
}
