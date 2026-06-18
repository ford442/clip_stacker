import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  TransitionType,
} from '../types';
import { computeFadeAlpha } from './fadePreview';
import {
  clampOverlayPosition,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  getClipDuration,
} from './project';
import { parseOutputResolution } from './resolution';
import { clampScrollSpeed } from './textOverlay';
import { computeTotalDuration } from './transitions';
import { getTimelineClips } from './timelineClips';

export type PreviewLayerKind = 'base' | 'pip' | 'text';

export interface PreviewPipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Active dissolve / motion overlap between two adjacent timeline clips. */
export interface PreviewTransitionCrossfade {
  type: TransitionType;
  /** Output-timeline start of the overlap window (seconds). */
  startTime: number;
  duration: number;
  /** 0 at overlap start → 1 at overlap end. */
  progress: number;
  outgoingClipId: string;
  incomingClipId: string;
  /** Whether this layer is the outgoing or incoming side of the crossfade. */
  role: 'outgoing' | 'incoming';
}

export interface PreviewClipLayer {
  kind: 'base' | 'pip';
  clipId: string;
  timelineIndex: number;
  zIndex: number;
  /** Seconds elapsed within the clip's trimmed output window. */
  localElapsed: number;
  clipDuration: number;
  /** Seek time in the clip's source media (seconds). */
  sourceTime: number;
  /** Combined opacity after fades, PiP opacity, and any transition crossfade. */
  opacity: number;
  rect: PreviewPipRect;
  crossfade: PreviewTransitionCrossfade | null;
}

export interface PreviewTextLayer {
  kind: 'text';
  overlayId: string;
  overlay: TextOverlay;
  timelineIndex: number;
  zIndex: number;
  x: number;
  y: number;
  opacity: number;
}

export type PreviewCompositionLayer = PreviewClipLayer | PreviewTextLayer;

export interface PreviewCompositionPlan {
  globalTime: number;
  totalDuration: number;
  canvasWidth: number;
  canvasHeight: number;
  /** Bottom → top draw order. */
  layers: PreviewCompositionLayer[];
  isEmpty: boolean;
}

interface ClipTimelineSegment {
  clip: Clip;
  /** Index in the full timeline clip list. */
  timelineIndex: number;
  /** Index within the scheduled clip list passed to buildClipTimelineSegments. */
  scheduleIndex: number;
  duration: number;
  startTime: number;
  endTime: number;
}

function isActiveTransition(transition: ClipTransition | undefined): transition is ClipTransition {
  return Boolean(transition && transition.type !== 'none' && transition.duration > 0);
}

function buildTransitionMap(transitions: ClipTransition[]): Map<number, ClipTransition> {
  return new Map(
    transitions
      .filter((transition) => isActiveTransition(transition))
      .map((transition) => [transition.afterClipIndex, transition] as const),
  );
}

function isBaseClip(clip: Clip): boolean {
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

function resolveCanvasSize(settings?: Pick<ExportSettings, 'outputResolution'>): {
  canvasWidth: number;
  canvasHeight: number;
} {
  const { width, height } = parseOutputResolution(settings?.outputResolution);
  return {
    canvasWidth: width || DEFAULT_CANVAS_WIDTH,
    canvasHeight: height || DEFAULT_CANVAS_HEIGHT,
  };
}

function resolveClipRect(
  clip: Clip,
  canvasWidth: number,
  canvasHeight: number,
): PreviewPipRect {
  if (isBaseClip(clip)) {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  }

  const { x, y } = clampOverlayPosition(clip, canvasWidth, canvasHeight);
  const width =
    clip.width && clip.width > 0
      ? clip.width
      : clip.videoWidth && clip.videoWidth > 0
        ? clip.videoWidth
        : canvasWidth;
  const height =
    clip.height && clip.height > 0
      ? clip.height
      : clip.videoHeight && clip.videoHeight > 0
        ? clip.videoHeight
        : canvasHeight;

  return { x, y, width, height };
}

function isClipActiveAtTime(segment: ClipTimelineSegment, globalTime: number): boolean {
  return globalTime >= segment.startTime && globalTime < segment.endTime;
}

function buildCrossfadeForSegment(
  segments: ClipTimelineSegment[],
  scheduleIndex: number,
  globalTime: number,
  transitions: ClipTransition[],
): PreviewTransitionCrossfade | null {
  if (scheduleIndex <= 0) return null;

  const segment = segments[scheduleIndex];
  const transition = transitions.find(
    (item) => item.afterClipIndex === scheduleIndex,
  );
  if (!isActiveTransition(transition)) return null;

  const overlapStart = segment.startTime;
  const overlapEnd = overlapStart + transition.duration;
  if (globalTime < overlapStart || globalTime >= overlapEnd) return null;

  const progress = Math.max(
    0,
    Math.min(1, (globalTime - overlapStart) / transition.duration),
  );

  return {
    type: transition.type,
    startTime: overlapStart,
    duration: transition.duration,
    progress,
    outgoingClipId: segments[scheduleIndex - 1].clip.id,
    incomingClipId: segment.clip.id,
    role: 'incoming',
  };
}

function clipLayerOpacity(
  clip: Clip,
  localElapsed: number,
  clipDuration: number,
  crossfade: PreviewTransitionCrossfade | null,
): number {
  const fadeAlpha = computeFadeAlpha(
    localElapsed,
    clipDuration,
    clip.videoFadeIn,
    clip.videoFadeOut,
  );
  const pipOpacity = !isBaseClip(clip) ? (clip.opacity ?? 1) : 1;

  if (!crossfade) {
    return fadeAlpha * pipOpacity;
  }

  const crossfadeAlpha =
    crossfade.role === 'incoming' ? crossfade.progress : 1 - crossfade.progress;
  return fadeAlpha * pipOpacity * crossfadeAlpha;
}

function buildScheduledClipLayer(
  segment: ClipTimelineSegment,
  globalTime: number,
  segments: ClipTimelineSegment[],
  transitions: ClipTransition[],
  canvasWidth: number,
  canvasHeight: number,
): PreviewClipLayer | null {
  if (!isClipActiveAtTime(segment, globalTime)) return null;

  const localElapsed = globalTime - segment.startTime;
  const crossfade = buildCrossfadeForSegment(
    segments,
    segment.scheduleIndex,
    globalTime,
    transitions,
  );

  return {
    kind: 'base',
    clipId: segment.clip.id,
    timelineIndex: segment.timelineIndex,
    zIndex:
      segment.scheduleIndex * 10 + (crossfade?.role === 'incoming' ? 1 : 0),
    localElapsed,
    clipDuration: segment.duration,
    sourceTime: segment.clip.trimStart + localElapsed,
    opacity: clipLayerOpacity(segment.clip, localElapsed, segment.duration, crossfade),
    rect: resolveClipRect(segment.clip, canvasWidth, canvasHeight),
    crossfade,
  };
}

function buildOutgoingCrossfadeLayer(
  segment: ClipTimelineSegment,
  crossfade: PreviewTransitionCrossfade,
  globalTime: number,
  canvasWidth: number,
  canvasHeight: number,
): PreviewClipLayer {
  const outgoingElapsed = globalTime - segment.startTime;
  const outgoingCrossfade: PreviewTransitionCrossfade = {
    ...crossfade,
    role: 'outgoing',
  };

  return {
    kind: 'base',
    clipId: segment.clip.id,
    timelineIndex: segment.timelineIndex,
    zIndex: segment.scheduleIndex * 10,
    localElapsed: outgoingElapsed,
    clipDuration: segment.duration,
    sourceTime: segment.clip.trimStart + outgoingElapsed,
    opacity: clipLayerOpacity(
      segment.clip,
      outgoingElapsed,
      segment.duration,
      outgoingCrossfade,
    ),
    rect: resolveClipRect(segment.clip, canvasWidth, canvasHeight),
    crossfade: outgoingCrossfade,
  };
}

function isInIncomingCrossfade(
  segments: ClipTimelineSegment[],
  scheduleIndex: number,
  globalTime: number,
  transitions: ClipTransition[],
): boolean {
  return buildCrossfadeForSegment(segments, scheduleIndex, globalTime, transitions) !== null;
}

function collectScheduledClipLayers(
  segments: ClipTimelineSegment[],
  transitions: ClipTransition[],
  globalTime: number,
  canvasWidth: number,
  canvasHeight: number,
): PreviewClipLayer[] {
  const clipLayers: PreviewClipLayer[] = [];

  for (const segment of segments) {
    if (!isClipActiveAtTime(segment, globalTime)) continue;

    const crossfade = buildCrossfadeForSegment(
      segments,
      segment.scheduleIndex,
      globalTime,
      transitions,
    );

    if (crossfade && segment.scheduleIndex > 0) {
      clipLayers.push(
        buildOutgoingCrossfadeLayer(
          segments[segment.scheduleIndex - 1],
          crossfade,
          globalTime,
          canvasWidth,
          canvasHeight,
        ),
      );
      const incomingLayer = buildScheduledClipLayer(
        segment,
        globalTime,
        segments,
        transitions,
        canvasWidth,
        canvasHeight,
      );
      if (incomingLayer) clipLayers.push(incomingLayer);
      continue;
    }

    const nextSegment = segments[segment.scheduleIndex + 1];
    if (
      nextSegment &&
      isInIncomingCrossfade(
        segments,
        nextSegment.scheduleIndex,
        globalTime,
        transitions,
      )
    ) {
      continue;
    }

    const layer = buildScheduledClipLayer(
      segment,
      globalTime,
      segments,
      transitions,
      canvasWidth,
      canvasHeight,
    );
    if (layer) clipLayers.push(layer);
  }

  return clipLayers;
}

/** PiP overlays begin at output time 0 (matches FFmpeg overlay filter timing). */
function buildPipLayers(
  pipClips: Array<{ clip: Clip; timelineIndex: number }>,
  globalTime: number,
  totalDuration: number,
  canvasWidth: number,
  canvasHeight: number,
): PreviewClipLayer[] {
  if (globalTime < 0 || globalTime >= totalDuration) return [];

  return [...pipClips]
    .sort(
      (a, b) =>
        (a.clip.layerIndex ?? 1) - (b.clip.layerIndex ?? 1) ||
        a.timelineIndex - b.timelineIndex,
    )
    .map(({ clip, timelineIndex }) => {
      const duration = getClipDuration(clip);
      const localElapsed = Math.min(globalTime, Math.max(0, duration - 1e-6));

      return {
        kind: 'pip' as const,
        clipId: clip.id,
        timelineIndex,
        zIndex: 1000 + (clip.layerIndex ?? 1) * 100 + timelineIndex,
        localElapsed,
        clipDuration: duration,
        sourceTime: clip.trimStart + localElapsed,
        opacity: clipLayerOpacity(clip, localElapsed, duration, null),
        rect: resolveClipRect(clip, canvasWidth, canvasHeight),
        crossfade: null,
      };
    });
}

function resolveTextOverlayX(
  overlay: TextOverlay,
  globalTime: number,
  canvasWidth: number,
): number {
  if (!overlay.scrolling) return overlay.x;
  const fraction = clampScrollSpeed(overlay.scrollSpeed) / 100;
  return canvasWidth - globalTime * canvasWidth * fraction;
}

function buildTextLayers(
  overlays: TextOverlay[],
  globalTime: number,
  totalDuration: number,
  canvasWidth: number,
): PreviewTextLayer[] {
  if (overlays.length === 0 || totalDuration <= 0) return [];
  if (globalTime < 0 || globalTime > totalDuration) return [];

  return overlays.map((overlay, index) => ({
    kind: 'text',
    overlayId: overlay.id,
    overlay,
    timelineIndex: index,
    zIndex: 2000 + index,
    x: resolveTextOverlayX(overlay, globalTime, canvasWidth),
    y: overlay.y,
    opacity: 1,
  }));
}

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
): PreviewCompositionPlan {
  const timelineClips = getTimelineClips(clips, groups);
  const { canvasWidth, canvasHeight } = resolveCanvasSize(settings);
  const isEmpty = timelineClips.length === 0 && overlays.length === 0;

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

  const totalDuration = computeTotalDuration(scheduleClips, scheduleTransitions);
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
      layers: [],
      isEmpty,
    };
  }

  const clipLayers = [
    ...collectScheduledClipLayers(
      segments,
      scheduleTransitions,
      globalTime,
      canvasWidth,
      canvasHeight,
    ),
    ...buildPipLayers(
      pipClips,
      globalTime,
      totalDuration,
      canvasWidth,
      canvasHeight,
    ),
  ];

  const textLayers = buildTextLayers(
    overlays,
    globalTime,
    totalDuration,
    canvasWidth,
  );

  const layers = [...clipLayers, ...textLayers].sort((a, b) => a.zIndex - b.zIndex);

  return {
    globalTime,
    totalDuration,
    canvasWidth,
    canvasHeight,
    layers,
    isEmpty,
  };
}
