/**
 * Timeline segment scheduling and per-clip destination-rect geometry for the
 * composition planner (`previewComposition.ts`, which keeps
 * `buildPreviewCompositionPlan` as the single entry point). Split out purely
 * to keep each module under the repo's ~700-line convention.
 */

import type { Clip, ClipTransition, ExportSettings } from '../types';
import { DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH, getClipDuration } from './project';
import { parseOutputResolution } from './resolution';
import { clipHasKeyframes, resolveAnimatedClipLayout } from './animatedLayout';
import { capPreviewResolution, DEFAULT_PREVIEW_MAX_HEIGHT } from './previewBudget';
import type { CanvasGeometry, ClipTimelineSegment, PreviewPipRect } from './previewCompositionTypes';

export function isActiveTransition(
  transition: ClipTransition | undefined,
): transition is ClipTransition {
  return Boolean(transition && transition.type !== 'none' && transition.duration > 0);
}

function buildTransitionMap(transitions: ClipTransition[]): Map<number, ClipTransition> {
  return new Map(
    transitions
      .filter((transition) => isActiveTransition(transition))
      .map((transition) => [transition.afterClipIndex, transition] as const),
  );
}

export function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

/** Keep transitions between adjacent base-layer clips (matches FFmpeg PiP base chain). */
export function filterBaseLayerTransitions(
  timelineClips: Clip[],
  transitions: ClipTransition[],
): ClipTransition[] {
  const baseTimelineIndices = timelineClips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => isBaseClip(clip))
    .map(({ index }) => index);

  const remapped: ClipTransition[] = [];
  for (let baseSlot = 1; baseSlot < baseTimelineIndices.length; baseSlot++) {
    const previousTimelineIndex = baseTimelineIndices[baseSlot - 1];
    const timelineIndex = baseTimelineIndices[baseSlot];
    if (timelineIndex !== previousTimelineIndex + 1) continue;

    const transition = transitions.find(
      (item) => item.afterClipIndex === timelineIndex,
    );
    if (isActiveTransition(transition)) {
      remapped.push({ ...transition, afterClipIndex: baseSlot });
    }
  }
  return remapped;
}

/** Map each clip to its output start/end times (matches xfade offset math). */
export function buildClipTimelineSegments(
  clips: Clip[],
  transitions: ClipTransition[],
  timelineIndices: number[],
): ClipTimelineSegment[] {
  if (clips.length === 0) return [];

  const durations = clips.map(getClipDuration);
  const transMap = buildTransitionMap(transitions);
  const segments: ClipTimelineSegment[] = [];
  let accumulated = 0;
  let overlapSoFar = 0;

  for (let scheduleIndex = 0; scheduleIndex < clips.length; scheduleIndex++) {
    let startTime = 0;
    if (scheduleIndex > 0) {
      const transition = transMap.get(scheduleIndex);
      startTime = transition
        ? accumulated - overlapSoFar - transition.duration
        : accumulated - overlapSoFar;
    }

    segments.push({
      clip: clips[scheduleIndex],
      timelineIndex: timelineIndices[scheduleIndex],
      scheduleIndex,
      duration: durations[scheduleIndex],
      startTime,
      endTime: startTime + durations[scheduleIndex],
    });

    if (scheduleIndex > 0) {
      const appliedTransition = transMap.get(scheduleIndex);
      if (appliedTransition) {
        overlapSoFar += appliedTransition.duration;
      }
    }
    accumulated += durations[scheduleIndex];
  }

  return segments;
}

export interface CanvasSizeOptions {
  maxHeight?: number;
  maxWidth?: number;
}

export function resolveCanvasSize(
  settings: Pick<ExportSettings, 'outputResolution'> | undefined,
  options: CanvasSizeOptions,
): CanvasGeometry {
  const { width, height } = parseOutputResolution(settings?.outputResolution);
  const outputWidth = width || DEFAULT_CANVAS_WIDTH;
  const outputHeight = height || DEFAULT_CANVAS_HEIGHT;

  let canvasWidth = outputWidth;
  let canvasHeight = outputHeight;
  let scale = 1;
  let capped = false;

  const maxHeight = options.maxHeight ?? DEFAULT_PREVIEW_MAX_HEIGHT;
  const heightCap = capPreviewResolution(canvasWidth, canvasHeight, maxHeight);
  canvasWidth = heightCap.width;
  canvasHeight = heightCap.height;
  scale = heightCap.scale;
  capped = heightCap.capped;

  if (options.maxWidth && canvasWidth > options.maxWidth) {
    const widthScale = options.maxWidth / canvasWidth;
    canvasWidth = options.maxWidth;
    canvasHeight = Math.max(1, Math.round(canvasHeight * widthScale));
    scale *= widthScale;
    capped = true;
  }

  return {
    outputWidth,
    outputHeight,
    canvasWidth,
    canvasHeight,
    scale,
    capped,
  };
}

/**
 * Resolve a clip's destination rect and optional UV animation at `localTime`.
 */
export function resolveClipRectAtTime(
  clip: Clip,
  geom: CanvasGeometry,
  localTime: number,
): { rect: PreviewPipRect; uvScale: [number, number]; uvOffset: [number, number] } {
  const isBase = (clip.layerIndex ?? 0) === 0;
  const hasAnimation = clip.stillImage || clipHasKeyframes(clip) || !isBase;

  if (isBase && !hasAnimation) {
    return {
      rect: { x: 0, y: 0, width: geom.canvasWidth, height: geom.canvasHeight },
      uvScale: [1, 1],
      uvOffset: [0, 0],
    };
  }

  const layout = resolveAnimatedClipLayout(
    clip,
    localTime,
    geom.outputWidth,
    geom.outputHeight,
    geom.scale,
  );

  if (isBase && !clip.stillImage && !clipHasKeyframes(clip)) {
    return {
      rect: { x: 0, y: 0, width: geom.canvasWidth, height: geom.canvasHeight },
      uvScale: layout.uvScale,
      uvOffset: layout.uvOffset,
    };
  }

  return {
    rect: {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
    },
    uvScale: layout.uvScale,
    uvOffset: layout.uvOffset,
  };
}

export function isClipActiveAtTime(segment: ClipTimelineSegment, globalTime: number): boolean {
  return globalTime >= segment.startTime && globalTime < segment.endTime;
}
