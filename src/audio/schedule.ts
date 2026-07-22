import type { Clip, ClipGroup, ClipTransition } from '../types';
import {
  buildClipTimelineSegments,
  filterBaseLayerTransitions,
} from '../utils/previewComposition';
import { getClipDuration } from '../utils/project';
import { getTimelineClips } from '../utils/timelineClips';
import { clampClipVolume } from '../utils/audioVolume';

/** One clip's audio placement on the output timeline. */
export interface AudioScheduleEntry {
  clipId: string;
  objectUrl: string;
  /** Output-timeline time when this clip's audio begins (seconds). */
  timelineStart: number;
  /** Trimmed duration on the output timeline (seconds). */
  duration: number;
  /** Offset into the source media / AudioBuffer (seconds). */
  bufferOffset: number;
  volume: number;
  audioFadeIn: number;
  audioFadeOut: number;
}

function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

function entryFromClip(
  clip: Clip,
  timelineStart: number,
  duration: number,
): AudioScheduleEntry {
  return {
    clipId: clip.id,
    objectUrl: clip.objectUrl,
    timelineStart,
    duration,
    bufferOffset: Math.max(0, clip.trimStart),
    volume: clampClipVolume(clip.volume),
    audioFadeIn: Math.max(0, clip.audioFadeIn),
    audioFadeOut: Math.max(0, clip.audioFadeOut),
  };
}

/**
 * Build sample-accurate audio placements for every audible timeline clip.
 *
 * Base-layer clips follow xfade segment math (including transition overlaps so
 * adjacent clips share audio during dissolves — no hard gap). PiP overlays
 * begin at output time 0 (matches FFmpeg overlay timing).
 */
export function buildAudioSchedule(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
): AudioScheduleEntry[] {
  const timelineClips = getTimelineClips(clips, groups);
  if (timelineClips.length === 0) return [];

  const baseClips = timelineClips.filter(isBaseClip);
  const pipClips = timelineClips.filter((clip) => !isBaseClip(clip));
  const hasPip = pipClips.length > 0;

  const scheduleClips = hasPip ? baseClips : timelineClips;
  const scheduleTimelineIndices = hasPip
    ? timelineClips
        .map((clip, index) => ({ clip, index }))
        .filter(({ clip }) => isBaseClip(clip))
        .map(({ index }) => index)
    : timelineClips.map((_, index) => index);
  const scheduleTransitions = hasPip
    ? filterBaseLayerTransitions(timelineClips, transitions)
    : transitions;

  const segments = buildClipTimelineSegments(
    scheduleClips,
    scheduleTransitions,
    scheduleTimelineIndices,
  );

  const entries: AudioScheduleEntry[] = segments.map((segment) =>
    entryFromClip(segment.clip, segment.startTime, segment.duration),
  );

  for (const clip of pipClips) {
    entries.push(entryFromClip(clip, 0, getClipDuration(clip)));
  }

  return entries;
}

/** Entries that still have audio remaining at (or after) `globalTime`. */
export function entriesActiveAtOrAfter(
  entries: AudioScheduleEntry[],
  globalTime: number,
): AudioScheduleEntry[] {
  return entries.filter(
    (entry) =>
      entry.duration > 0 &&
      globalTime < entry.timelineStart + entry.duration - 1e-6,
  );
}
