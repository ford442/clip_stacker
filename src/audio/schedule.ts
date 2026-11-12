import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import {
  buildClipTimelineSegments,
  filterBaseLayerTransitions,
} from '../composition/previewComposition';
import { getClipDuration } from '../timeline/clipTiming';
import { getTimelineClips } from '../timeline/timelineClips';
import { audioTracks, videoTracks } from '../timeline/trackModel';
import { placementWindow } from '../timeline/trackStacking';
import { clampClipVolume } from './audioVolume';
import type { Keyframe } from '../timeline/keyframes';
import { normalizeClipAutomation } from '../timeline/clipAutomation';
import { getClipLoopCount, getClipPlaybackRate } from '../timeline/playbackRate';
import { clipIsReversed } from '../timeline/reverseClip';
import { clipHasRateAutomation, cycleDurationForClip } from '../timeline/timeRemap';
import { NESTED_SEQUENCE_MAX_DEPTH, isSequenceClip } from '../timeline/sequenceResolve';
import { placeNestedEntries } from './scheduleNested';
import type { AudioScheduleEntry } from './scheduleEntry';
import {
  audioEffectsSignature,
  clipAudioEffectsActive,
  normalizeClipAudioEffects,
} from './audioEffects';

export type { AudioScheduleEntry } from './scheduleEntry';

/**
 * Linear gain applied to overlapping bed clips (≈ −9 dB): the legacy duck,
 * a fixed step for the whole entry. Lanes that set `Track.duck` replace it
 * with the bus graph's sidechain envelope (or nothing).
 */
export const BED_DUCK_LINEAR = 0.35;

function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

/** The lane-routing fields an entry inherits from its holding track. */
function laneFields(track: Track | undefined): Pick<AudioScheduleEntry, 'trackId' | 'laneDuck'> {
  if (!track) return {};
  const duck = track.duck;
  return {
    trackId: track.id,
    ...(duck === 'off' ? { laneDuck: 'off' as const } : duck ? { laneDuck: 'sidechain' as const } : {}),
  };
}

function entryFromClip(
  clip: Clip,
  timelineStart: number,
  duration: number,
  isBed = false,
  track?: Track,
): AudioScheduleEntry {
  const automation = normalizeClipAutomation(clip.automation);
  const rateRemap = clipHasRateAutomation(clip);
  const reversed = clipIsReversed(clip);
  // A speed curve already rebuilds the buffer. Constant-rate reverse is a
  // plain sample reversal of the trim, then the same playbackRate as forward.
  const reverseAudio = reversed && !rateRemap;
  const audioEffects = clipAudioEffectsActive(clip.audioEffects)
    ? normalizeClipAudioEffects(clip.audioEffects)
    : undefined;
  return {
    clipId: clip.id,
    objectUrl: clip.objectUrl,
    timelineStart,
    duration,
    cycleDuration: cycleDurationForClip(clip),
    loopCount: getClipLoopCount(clip),
    // Remapped and reversed buffers already start at the trim window.
    bufferOffset: rateRemap || reverseAudio ? 0 : Math.max(0, clip.trimStart),
    volume: clampClipVolume(clip.volume),
    audioFadeIn: Math.max(0, clip.audioFadeIn),
    audioFadeOut: Math.max(0, clip.audioFadeOut),
    playbackRate: rateRemap ? 1 : getClipPlaybackRate(clip),
    ...(automation?.volume?.length
      ? { volumeAutomation: automation.volume }
      : {}),
    ...(automation?.pan?.length ? { panAutomation: automation.pan } : {}),
    ...(audioEffects ? { audioEffects } : {}),
    ...(rateRemap
      ? {
          rateRemap: true,
          rateRemapClip: {
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd,
            duration: clip.duration,
            playbackRate: clip.playbackRate,
            automation: clip.automation,
            ...(reversed ? { reversed: true } : {}),
          },
        }
      : {}),
    ...(reverseAudio
      ? {
          reverseAudio: true,
          reverseClip: {
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd,
            duration: clip.duration,
          },
        }
      : {}),
    ...(isBed ? { isBed: true } : {}),
    ...laneFields(track),
  };
}

/**
 * Build sample-accurate audio placements for every audible timeline clip.
 *
 * A sequence clip contributes its nested sequence's schedule, cut to the
 * clip's in / out window and mixed into the clip's lane (`scheduleNested.ts`).
 *
 * Base-layer clips follow xfade segment math (including transition overlaps so
 * adjacent clips share audio during dissolves — no hard gap). Overlay-lane
 * clips are placed at their track item's output time (`Clip.timelineStart`,
 * derived in `timeline/trackStacking.ts`).
 *
 * Lane mute is honored on every kind of lane: clips flattened from a muted
 * video lane carry `trackMuted` and are skipped here, and muted audio lanes
 * contribute no bed entries. Because the flag travels on the clip, the export
 * premix (`export/webcodecsAudio.ts`, which is handed the flattened view) drops
 * the same entries the preview does.
 */
export function buildAudioSchedule(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  tracks: Track[] = [],
): AudioScheduleEntry[] {
  return buildScheduleAtDepth(clips, groups, transitions, tracks, 0);
}

/**
 * A sequence clip's audio: its nested sequence's schedule (built the same
 * way, one level deeper), placed on this timeline — see `scheduleNested.ts`.
 */
function sequenceClipEntries(
  clip: Clip,
  timelineStart: number,
  duration: number,
  track: Track | undefined,
  depth: number,
): AudioScheduleEntry[] {
  const content = clip.nested;
  if (!content || depth + 1 > NESTED_SEQUENCE_MAX_DEPTH) return [];
  const inner = buildScheduleAtDepth(content.clips, [], content.transitions, content.tracks, depth + 1);
  return placeNestedEntries(inner, {
    parentClipId: clip.id,
    placementStart: timelineStart,
    inPoint: Math.max(0, clip.trimStart),
    duration,
    volume: clampClipVolume(clip.volume),
    lane: laneFields(track),
  });
}

function buildScheduleAtDepth(
  clips: Clip[],
  groups: ClipGroup[],
  transitions: ClipTransition[],
  tracks: Track[],
  depth: number,
): AudioScheduleEntry[] {
  const timelineClips = getTimelineClips(clips, groups);
  if (timelineClips.length === 0) return [];

  // Audio-kind clips are placed only via audio tracks (below). Including them
  // in the base/PiP layout would double-schedule beds and break ducking.
  const videoTimelineClips = timelineClips.filter((clip) => clip.kind !== 'audio');
  if (videoTimelineClips.length === 0 && audioTracks(tracks).length === 0) {
    return [];
  }

  const baseClips = videoTimelineClips.filter(isBaseClip);
  const pipClips = videoTimelineClips.filter((clip) => !isBaseClip(clip));
  const hasPip = pipClips.length > 0;

  const scheduleClips = hasPip ? baseClips : videoTimelineClips;
  const scheduleTimelineIndices = hasPip
    ? videoTimelineClips
        .map((clip, index) => ({ clip, index }))
        .filter(({ clip }) => isBaseClip(clip))
        .map(({ index }) => index)
    : videoTimelineClips.map((_, index) => index);
  const scheduleTransitions = hasPip
    ? filterBaseLayerTransitions(videoTimelineClips, transitions)
    : transitions;

  const entries: AudioScheduleEntry[] = [];
  // `layerIndex` is the clip's position among the video lanes (derived by
  // `toLegacyTimelineView`), so it names the holding lane.
  const vLanes = videoTracks(tracks);
  const videoLane = (clip: Clip) => vLanes[clip.layerIndex ?? 0];

  if (scheduleClips.length > 0) {
    const segments = buildClipTimelineSegments(
      scheduleClips,
      scheduleTransitions,
      scheduleTimelineIndices,
    );
    for (const segment of segments) {
      if (segment.clip.trackMuted) continue;
      if (isSequenceClip(segment.clip)) {
        entries.push(
          ...sequenceClipEntries(segment.clip, segment.startTime, segment.duration, videoLane(segment.clip), depth),
        );
        continue;
      }
      entries.push(
        entryFromClip(segment.clip, segment.startTime, segment.duration, false, videoLane(segment.clip)),
      );
    }
  }

  for (const clip of pipClips) {
    if (clip.trackMuted) continue;
    const duration = getClipDuration(clip);
    const { start } = placementWindow(clip, duration);
    if (isSequenceClip(clip)) {
      entries.push(...sequenceClipEntries(clip, start, duration, videoLane(clip), depth));
      continue;
    }
    entries.push(entryFromClip(clip, start, duration, false, videoLane(clip)));
  }

  // Concurrent audio-bed clips from dedicated audio tracks.
  const clipsById = new Map(timelineClips.map((c) => [c.id, c]));
  for (const track of audioTracks(tracks)) {
    if (track.muted) continue;
    for (const item of track.items) {
      const clip = clipsById.get(item.clipId);
      if (!clip || clip.kind !== 'audio') continue;
      entries.push(entryFromClip(clip, item.startTime, getClipDuration(clip), true, track));
    }
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

/** True when two schedule lists place the same clips/buffers at the same times. */
export function schedulesMatchStructure(
  a: AudioScheduleEntry[],
  b: AudioScheduleEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.clipId !== right.clipId ||
      left.objectUrl !== right.objectUrl ||
      left.timelineStart !== right.timelineStart ||
      left.duration !== right.duration ||
      left.cycleDuration !== right.cycleDuration ||
      left.loopCount !== right.loopCount ||
      left.bufferOffset !== right.bufferOffset ||
      left.playbackRate !== right.playbackRate ||
      Boolean(left.rateRemap) !== Boolean(right.rateRemap) ||
      Boolean(left.reverseAudio) !== Boolean(right.reverseAudio) ||
      Boolean(left.rateRemapClip?.reversed) !== Boolean(right.rateRemapClip?.reversed) ||
      Boolean(left.isBed) !== Boolean(right.isBed) ||
      left.trackId !== right.trackId ||
      left.laneDuck !== right.laneDuck ||
      !keyframesMatch(left.volumeAutomation, right.volumeAutomation) ||
      !keyframesMatch(left.panAutomation, right.panAutomation) ||
      // Insert changes swap the processed buffer, so live gain updates are not enough.
      audioEffectsSignature(left.audioEffects) !== audioEffectsSignature(right.audioEffects) ||
      !keyframesMatch(
        left.rateRemapClip?.automation?.playbackRate,
        right.rateRemapClip?.automation?.playbackRate,
      )
    ) {
      return false;
    }
  }
  return true;
}

function keyframesMatch(
  a: Keyframe[] | undefined,
  b: Keyframe[] | undefined,
): boolean {
  if (!a?.length && !b?.length) return true;
  if (!a?.length || !b?.length || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].t !== b[i].t ||
      a[i].value !== b[i].value ||
      a[i].easing?.type !== b[i].easing?.type ||
      a[i].easing?.x1 !== b[i].easing?.x1 ||
      a[i].easing?.y1 !== b[i].easing?.y1 ||
      a[i].easing?.x2 !== b[i].easing?.x2 ||
      a[i].easing?.y2 !== b[i].easing?.y2
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a bed entry's timeline range overlaps any non-bed (dialogue) entry.
 * Used for real-time volume ducking under speech / base clips.
 */
export function bedOverlapsDialogue(
  entry: AudioScheduleEntry,
  schedule: AudioScheduleEntry[],
): boolean {
  if (!entry.isBed || entry.laneDuck) return false;
  const entryEnd = entry.timelineStart + entry.duration;
  return schedule.some((other) => {
    if (other.isBed || other.clipId === entry.clipId) return false;
    const otherEnd = other.timelineStart + other.duration;
    return other.timelineStart < entryEnd && entry.timelineStart < otherEnd;
  });
}

/** Effective linear volume after optional bed ducking. */
export function effectiveEntryVolume(
  entry: AudioScheduleEntry,
  schedule: AudioScheduleEntry[],
  duckLinear: number = BED_DUCK_LINEAR,
): number {
  if (bedOverlapsDialogue(entry, schedule)) {
    return entry.volume * duckLinear;
  }
  return entry.volume;
}
