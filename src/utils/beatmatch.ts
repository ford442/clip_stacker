/**
 * Beatmatch planning: turn a follower clip plus a tempo target into a playback
 * rate and a timeline start time.
 *
 * Everything here is pure — the Inspector applies the results through the
 * existing clip/track updaters. Beat times are handled in two spaces:
 * *source* seconds (as stored on `beatTimestamps`) and *timeline* seconds
 * (after trim, playback rate and the track item's start offset).
 */

import type { Clip, MasterAudio, Track } from '../types';
import { beatsInTrimWindow } from './beatMarkers';
import { getClipPlaybackRate } from './playbackRate';
import { getClipBpm, snapToNearestBeat } from './tempo';
import { findClipTrack } from './trackModel';

/** A tempo reference a clip can be matched against. */
export interface BeatmatchTarget {
  /** `master` for the master audio lane, otherwise the target clip's id. */
  id: string;
  label: string;
  bpm: number;
  /** Beat times in timeline seconds, ascending. */
  beatsAbs: number[];
}

/** Timeline start of a clip's track item (0 when the clip is not placed). */
export function clipItemStartTime(tracks: Track[], clipId: string): number {
  const found = findClipTrack(tracks, clipId);
  if (!found) return 0;
  return found.track.items[found.itemIndex]?.startTime ?? 0;
}

/**
 * Beat times of a placed clip in timeline seconds.
 * `rate` is passed explicitly so a match can be planned against the rate that
 * is about to be applied rather than the one currently stored.
 */
export function clipBeatsAbs(
  clip: Clip,
  itemStartTime: number,
  rate = getClipPlaybackRate(clip),
): number[] {
  const safeRate = rate > 0 ? rate : 1;
  return beatsInTrimWindow(clip).map(
    (t) => itemStartTime + (t - clip.trimStart) / safeRate,
  );
}

/** Master beat times in timeline seconds. */
export function masterBeatsAbs(masterAudio: MasterAudio | null): number[] {
  if (!masterAudio?.beatTimestamps?.length) return [];
  return masterAudio.beatTimestamps
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= masterAudio.duration)
    .map((t) => masterAudio.startTime + t)
    .sort((a, b) => a - b);
}

/**
 * Every tempo reference available to `followerClipId`: the master audio when it
 * has a BPM, then each other placed clip with a BPM (detected or overridden).
 */
export function buildBeatmatchTargets(
  masterAudio: MasterAudio | null,
  clips: Clip[],
  tracks: Track[],
  followerClipId: string | null,
): BeatmatchTarget[] {
  const targets: BeatmatchTarget[] = [];

  if (masterAudio?.bpmEstimate != null && masterAudio.bpmEstimate > 0) {
    targets.push({
      id: 'master',
      label: `Master — ${masterAudio.fileName}`,
      bpm: masterAudio.bpmEstimate,
      beatsAbs: masterBeatsAbs(masterAudio),
    });
  }

  for (const clip of clips) {
    if (clip.id === followerClipId) continue;
    const bpm = getClipBpm(clip);
    if (bpm == null) continue;
    targets.push({
      id: clip.id,
      label: clip.title || clip.file.name,
      bpm,
      beatsAbs: clipBeatsAbs(clip, clipItemStartTime(tracks, clip.id)),
    });
  }

  return targets;
}

/**
 * Timeline start time that puts the follower's first in-trim beat on the
 * target's first beat. Null when either side has no usable beat.
 */
export function downbeatStartTime(
  clip: Clip,
  itemStartTime: number,
  rate: number,
  target: BeatmatchTarget,
): number | null {
  const followerBeats = clipBeatsAbs(clip, itemStartTime, rate);
  const followerBeat = followerBeats[0];
  const targetBeat = target.beatsAbs[0];
  if (followerBeat == null || targetBeat == null) return null;
  // phaseDelta = target − follower; applying it to the item start moves the
  // whole clip, so the first beats coincide.
  return Math.max(0, itemStartTime + (targetBeat - followerBeat));
}

/** Nearest target beat to the clip's current start (no-op without beats). */
export function snapStartToTargetBeat(
  itemStartTime: number,
  target: BeatmatchTarget | null,
): number | null {
  if (!target?.beatsAbs.length) return null;
  return Math.max(0, snapToNearestBeat(itemStartTime, target.beatsAbs));
}
