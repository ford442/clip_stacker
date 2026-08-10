import type { Clip, ClipGroup, ClipTransition, Track } from '../types';
import {
  buildClipTimelineSegments,
  filterBaseLayerTransitions,
} from '../utils/previewComposition';
import { getClipDuration } from '../utils/project';
import { getTimelineClips } from '../utils/timelineClips';
import { audioTracks } from '../utils/trackModel';
import { clampClipVolume } from '../utils/audioVolume';
import type { Keyframe } from '../utils/keyframes';
import { normalizeClipAutomation } from '../utils/clipAutomation';
import { getClipPlaybackRate } from '../utils/playbackRate';
import { clipHasRateAutomation } from '../utils/timeRemap';

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
  /** Constant source playback speed (1 = normal). Ignored when `rateRemap` is set. */
  playbackRate: number;
  /**
   * Absolute linear-gain keyframes (clip-local seconds). Empty → use `volume`.
   * Fades and bed ducking still multiply on top of the sampled level.
   */
  volumeAutomation?: Keyframe[];
  /** Stereo pan keyframes (−1 L … +1 R). Empty → centered (0). */
  panAutomation?: Keyframe[];
  /**
   * When true, audio is pitch-preserved WSOLA-remapped offline to `duration`
   * and played at rate 1 from buffer offset 0 (trim already baked in).
   */
  rateRemap?: boolean;
  /** Clip snapshot fields needed to rebuild a remapped buffer. */
  rateRemapClip?: Pick<
    Clip,
    'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation'
  >;
  /**
   * Audio-bed / music track clip. When its timeline range overlaps a non-bed
   * (dialogue / base) entry, playback ducks its gain for intelligible speech.
   */
  isBed?: boolean;
}

/** Linear gain applied to overlapping bed clips (≈ −9 dB). */
export const BED_DUCK_LINEAR = 0.35;

function isBaseClip(clip: Clip): boolean {
  return (clip.layerIndex ?? 0) === 0;
}

function entryFromClip(
  clip: Clip,
  timelineStart: number,
  duration: number,
  isBed = false,
): AudioScheduleEntry {
  const automation = normalizeClipAutomation(clip.automation);
  const rateRemap = clipHasRateAutomation(clip);
  return {
    clipId: clip.id,
    objectUrl: clip.objectUrl,
    timelineStart,
    duration,
    // Remapped buffers already start at the trim window.
    bufferOffset: rateRemap ? 0 : Math.max(0, clip.trimStart),
    volume: clampClipVolume(clip.volume),
    audioFadeIn: Math.max(0, clip.audioFadeIn),
    audioFadeOut: Math.max(0, clip.audioFadeOut),
    playbackRate: rateRemap ? 1 : getClipPlaybackRate(clip),
    ...(automation?.volume?.length
      ? { volumeAutomation: automation.volume }
      : {}),
    ...(automation?.pan?.length ? { panAutomation: automation.pan } : {}),
    ...(rateRemap
      ? {
          rateRemap: true,
          rateRemapClip: {
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd,
            duration: clip.duration,
            playbackRate: clip.playbackRate,
            automation: clip.automation,
          },
        }
      : {}),
    ...(isBed ? { isBed: true } : {}),
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
  tracks: Track[] = [],
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

  if (scheduleClips.length > 0) {
    const segments = buildClipTimelineSegments(
      scheduleClips,
      scheduleTransitions,
      scheduleTimelineIndices,
    );
    for (const segment of segments) {
      entries.push(entryFromClip(segment.clip, segment.startTime, segment.duration));
    }
  }

  for (const clip of pipClips) {
    entries.push(entryFromClip(clip, 0, getClipDuration(clip)));
  }

  // Concurrent audio-bed clips from dedicated audio tracks.
  const clipsById = new Map(timelineClips.map((c) => [c.id, c]));
  for (const track of audioTracks(tracks)) {
    if (track.muted) continue;
    for (const item of track.items) {
      const clip = clipsById.get(item.clipId);
      if (!clip || clip.kind !== 'audio') continue;
      entries.push(entryFromClip(clip, item.startTime, getClipDuration(clip), true));
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
      left.bufferOffset !== right.bufferOffset ||
      left.playbackRate !== right.playbackRate ||
      Boolean(left.rateRemap) !== Boolean(right.rateRemap) ||
      Boolean(left.isBed) !== Boolean(right.isBed) ||
      !keyframesMatch(left.volumeAutomation, right.volumeAutomation) ||
      !keyframesMatch(left.panAutomation, right.panAutomation) ||
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
  if (!entry.isBed) return false;
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
