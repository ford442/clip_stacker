/**
 * Per-frame clip layer construction (crossfades, morph transitions, PiP/
 * overlay lanes, stabilization + keying) for the composition planner
 * (`previewComposition.ts`, which keeps `buildPreviewCompositionPlan` as the
 * single entry point). Split out purely to keep each module under the repo's
 * ~700-line convention.
 */

import type { Clip, ClipTransition } from '../types';
import { computeFadeAlpha } from './fadePreview';
import { sampleKeyframes } from './keyframes';
import { getClipDuration } from './project';
import { sourceTimeAtOutputLocal, wrapOutputLocalToCycle } from './timeRemap';
import { isMorphSegmentReady, isMorphTransition, morphClipId } from './morphTransition';
import { placementWindow } from './trackStacking';
import { resolveTransitionShaderId } from '../webgpu/transitions/registry';
import { isStabilizationActive, stabMatrixForClip } from './stabilization';
import type { StabMatrix } from '../wasm/videoStabilize';
import { layerKeyEntry } from './overlayKey';
import type { CanvasGeometry, ClipTimelineSegment, PreviewClipLayer, PreviewTransitionCrossfade } from './previewCompositionTypes';
import { isActiveTransition, isBaseClip, isClipActiveAtTime, resolveClipRectAtTime } from './previewCompositionSegments';

/**
 * Spread-in `stabMatrix` for a clip, or nothing at all when it is not
 * stabilized — an absent key keeps unstabilized layers structurally identical
 * to what they were before stabilization existed.
 */
function stabMatrixEntry(
  clip: Clip,
  sourceTime: number,
): { stabMatrix?: StabMatrix } {
  if (!isStabilizationActive(clip)) return {};
  return { stabMatrix: stabMatrixForClip(clip, sourceTime) };
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
  if (isMorphTransition(transition) && isMorphSegmentReady(transition)) {
    return null;
  }

  const overlapStart = segment.startTime;
  const overlapEnd = overlapStart + transition.duration;
  if (globalTime < overlapStart || globalTime >= overlapEnd) return null;

  const progress = Math.max(
    0,
    Math.min(1, (globalTime - overlapStart) / transition.duration),
  );

  const previewType =
    isMorphTransition(transition) && !isMorphSegmentReady(transition)
      ? 'dissolve'
      : resolveTransitionShaderId(transition);

  return {
    type: previewType,
    startTime: overlapStart,
    duration: transition.duration,
    progress,
    outgoingClipId: segments[scheduleIndex - 1].clip.id,
    incomingClipId: segment.clip.id,
    role: 'incoming',
    params: transition.params,
  };
}

function isInMorphOverlap(
  segments: ClipTimelineSegment[],
  scheduleIndex: number,
  globalTime: number,
  transition: ClipTransition,
): boolean {
  if (scheduleIndex <= 0) return false;
  const segment = segments[scheduleIndex];
  const overlapStart = segment.startTime;
  return (
    globalTime >= overlapStart &&
    globalTime < overlapStart + transition.duration
  );
}

function buildMorphLayer(
  transition: ClipTransition,
  segment: ClipTimelineSegment,
  globalTime: number,
  geom: CanvasGeometry,
): PreviewClipLayer {
  const overlapStart = segment.startTime;
  const localElapsed = globalTime - overlapStart;
  const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
    segment.clip,
    geom,
    localElapsed,
  );
  return {
    kind: 'base',
    clipId: morphClipId(transition.afterClipIndex),
    timelineIndex: segment.timelineIndex,
    zIndex: segment.scheduleIndex * 10 + 1,
    localElapsed,
    clipDuration: transition.duration,
    sourceTime: localElapsed,
    opacity: 1,
    rect,
    crossfade: null,
    mediaObjectUrl: transition.morphSegment!.objectUrl,
    uvScale,
    uvOffset,
  };
}

function clipLayerOpacity(
  clip: Clip,
  localElapsed: number,
  clipDuration: number,
  crossfade: PreviewTransitionCrossfade | null,
): number {
  const staticOpacity = !isBaseClip(clip) ? (clip.opacity ?? 1) : 1;
  const keyedOpacity = sampleKeyframes(
    clip.keyframes?.opacity,
    localElapsed,
    staticOpacity,
  );
  const fadeAlpha = computeFadeAlpha(
    localElapsed,
    clipDuration,
    clip.videoFadeIn,
    clip.videoFadeOut,
  );

  if (!crossfade) {
    return fadeAlpha * keyedOpacity;
  }

  const crossfadeAlpha =
    crossfade.role === 'incoming' ? crossfade.progress : 1 - crossfade.progress;
  return fadeAlpha * keyedOpacity * crossfadeAlpha;
}

function buildScheduledClipLayer(
  segment: ClipTimelineSegment,
  globalTime: number,
  segments: ClipTimelineSegment[],
  transitions: ClipTransition[],
  geom: CanvasGeometry,
): PreviewClipLayer | null {
  if (!isClipActiveAtTime(segment, globalTime)) return null;

  const localElapsed = globalTime - segment.startTime;
  const crossfade = buildCrossfadeForSegment(
    segments,
    segment.scheduleIndex,
    globalTime,
    transitions,
  );
  const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
    segment.clip,
    geom,
    localElapsed,
  );

  const sourceTime = sourceTimeAtOutputLocal(
    segment.clip,
    wrapOutputLocalToCycle(segment.clip, localElapsed).cycleLocalT,
  );

  return {
    kind: 'base',
    clipId: segment.clip.id,
    timelineIndex: segment.timelineIndex,
    zIndex:
      segment.scheduleIndex * 10 + (crossfade?.role === 'incoming' ? 1 : 0),
    localElapsed,
    clipDuration: segment.duration,
    sourceTime,
    opacity: clipLayerOpacity(segment.clip, localElapsed, segment.duration, crossfade),
    rect,
    crossfade,
    uvScale,
    uvOffset,
    ...stabMatrixEntry(segment.clip, sourceTime),
    ...layerKeyEntry(segment.clip),
  };
}

function buildOutgoingCrossfadeLayer(
  segment: ClipTimelineSegment,
  crossfade: PreviewTransitionCrossfade,
  globalTime: number,
  geom: CanvasGeometry,
): PreviewClipLayer {
  const outgoingElapsed = globalTime - segment.startTime;
  const outgoingCrossfade: PreviewTransitionCrossfade = {
    ...crossfade,
    role: 'outgoing',
  };
  const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
    segment.clip,
    geom,
    outgoingElapsed,
  );

  const outgoingSourceTime = sourceTimeAtOutputLocal(
    segment.clip,
    wrapOutputLocalToCycle(segment.clip, outgoingElapsed).cycleLocalT,
  );

  return {
    kind: 'base',
    clipId: segment.clip.id,
    timelineIndex: segment.timelineIndex,
    zIndex: segment.scheduleIndex * 10,
    localElapsed: outgoingElapsed,
    clipDuration: segment.duration,
    sourceTime: outgoingSourceTime,
    opacity: clipLayerOpacity(
      segment.clip,
      outgoingElapsed,
      segment.duration,
      outgoingCrossfade,
    ),
    rect,
    crossfade: outgoingCrossfade,
    uvScale,
    uvOffset,
    ...stabMatrixEntry(segment.clip, outgoingSourceTime),
    ...layerKeyEntry(segment.clip),
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

export function collectScheduledClipLayers(
  segments: ClipTimelineSegment[],
  transitions: ClipTransition[],
  globalTime: number,
  geom: CanvasGeometry,
): PreviewClipLayer[] {
  const clipLayers: PreviewClipLayer[] = [];

  for (const segment of segments) {
    if (!isClipActiveAtTime(segment, globalTime)) continue;

    const transition = transitions.find(
      (item) => item.afterClipIndex === segment.scheduleIndex,
    );

    if (
      segment.scheduleIndex > 0 &&
      transition &&
      isMorphTransition(transition) &&
      isMorphSegmentReady(transition) &&
      isInMorphOverlap(
        segments,
        segment.scheduleIndex,
        globalTime,
        transition,
      )
    ) {
      clipLayers.push(
        buildMorphLayer(transition, segment, globalTime, geom),
      );
      continue;
    }

    const nextTransition = transitions.find(
      (item) => item.afterClipIndex === segment.scheduleIndex + 1,
    );
    if (
      nextTransition &&
      isMorphTransition(nextTransition) &&
      isMorphSegmentReady(nextTransition) &&
      segment.scheduleIndex + 1 < segments.length &&
      isInMorphOverlap(
        segments,
        segment.scheduleIndex + 1,
        globalTime,
        nextTransition,
      )
    ) {
      continue;
    }

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
          geom,
        ),
      );
      const incomingLayer = buildScheduledClipLayer(
        segment,
        globalTime,
        segments,
        transitions,
        geom,
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
      geom,
    );
    if (layer) clipLayers.push(layer);
  }

  return clipLayers;
}

/**
 * Overlay (non-base) video layers.
 *
 * Stacking order and timing come from the track model: `layerIndex` is the
 * clip's video-track index (bottom-up) and `timelineStart` is its
 * `TrackItem.startTime`, both stamped by `toLegacyTimelineView` via
 * `trackStacking.ts`. An overlay is drawn only while the playhead is inside
 * `[timelineStart, timelineStart + duration)`; legacy projects with no
 * placement fall back to `timelineStart = 0`, which is where the pre-track PiP
 * pipeline put them.
 */
export function buildPipLayers(
  pipClips: Array<{ clip: Clip; timelineIndex: number }>,
  globalTime: number,
  totalDuration: number,
  geom: CanvasGeometry,
): PreviewClipLayer[] {
  if (globalTime < 0 || globalTime >= totalDuration) return [];

  return [...pipClips]
    .sort(
      (a, b) =>
        (a.clip.layerIndex ?? 1) - (b.clip.layerIndex ?? 1) ||
        a.timelineIndex - b.timelineIndex,
    )
    .filter(({ clip }) => {
      const { start, end } = placementWindow(clip, getClipDuration(clip));
      return globalTime >= start && globalTime < end;
    })
    .map(({ clip, timelineIndex }) => {
      const duration = getClipDuration(clip);
      const { start } = placementWindow(clip, duration);
      const localElapsed = Math.min(
        Math.max(0, globalTime - start),
        Math.max(0, duration - 1e-6),
      );
      const { rect, uvScale, uvOffset } = resolveClipRectAtTime(
        clip,
        geom,
        localElapsed,
      );

      const sourceTime = sourceTimeAtOutputLocal(
        clip,
        wrapOutputLocalToCycle(clip, localElapsed).cycleLocalT,
      );

      return {
        kind: 'pip' as const,
        clipId: clip.id,
        timelineIndex,
        zIndex: 1000 + (clip.layerIndex ?? 1) * 100 + timelineIndex,
        localElapsed,
        clipDuration: duration,
        sourceTime,
        opacity: clipLayerOpacity(clip, localElapsed, duration, null),
        rect,
        crossfade: null,
        uvScale,
        uvOffset,
        ...stabMatrixEntry(clip, sourceTime),
        ...layerKeyEntry(clip),
      };
    });
}
