/**
 * Speed automation lane helpers — labels, snap targets, seed-rate memory.
 */

import type { Clip, SyncMarker } from '../types';
import { DEFAULT_BEAT_SNAP_THRESHOLD_MS } from './beatSnap';
import { getClipPlaybackRate } from './playbackRate';
import {
  clipHasRateAutomation,
  outputLocalAtSourceOffset,
} from './timeRemap';

export const SPEED_LANE_LAST_SEED_KEY = 'clip-stacker:speed-lane-last-seed-rate';

/** Default snap threshold for Alt/Option keyframe drag (seconds). */
export const SPEED_KEYFRAME_SNAP_THRESHOLD_SEC = DEFAULT_BEAT_SNAP_THRESHOLD_MS / 1000;

/** Effective pointer target diameter for keyframe handles (px). */
export const SPEED_KEYFRAME_HIT_PX = 44;

/** Coarse keyboard nudge for rate (×). */
export const SPEED_KEYFRAME_RATE_NUDGE = 0.05;
/** Fine keyboard nudge for rate (×) with Shift held. */
export const SPEED_KEYFRAME_RATE_NUDGE_FINE = 0.01;
/** Coarse keyboard nudge for keyframe time (seconds). */
export const SPEED_KEYFRAME_TIME_NUDGE_SEC = 0.05;
/** Fine keyboard nudge for keyframe time (seconds) with Shift held. */
export const SPEED_KEYFRAME_TIME_NUDGE_FINE_SEC = 0.01;

const RATE_TICKS = [0.25, 1, 4] as const;

export function formatPlaybackRateLabel(rate: number): string {
  return `${rate.toFixed(2)}×`;
}

/** Screen-reader phrasing, e.g. "0.75 times". */
export function formatPlaybackRateAria(rate: number): string {
  const trimmed = rate.toFixed(2).replace(/\.?0+$/, '');
  return `${trimmed} times`;
}

export function getLastSeedRate(): number {
  try {
    const raw = localStorage.getItem(SPEED_LANE_LAST_SEED_KEY);
    if (raw == null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

export function setLastSeedRate(rate: number): void {
  try {
    localStorage.setItem(SPEED_LANE_LAST_SEED_KEY, String(rate));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Vertical scale reference rates shown as tick marks in the lane. */
export function speedLaneRateTicks(): readonly number[] {
  return RATE_TICKS;
}

/**
 * Output-local snap targets for speed keyframes: clip sync markers, beats
 * (mapped through the rate curve), and master-audio markers on the timeline.
 */
export function collectSpeedKeyframeSnapTimes(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation' | 'syncMarkers' | 'beatTimestamps'>,
  clipOutputStart = 0,
  masterMarkers: SyncMarker[] = [],
): number[] {
  const times = new Set<number>();
  const trimStart = clip.trimStart;
  const trimEnd = Number.isFinite(clip.trimEnd) ? (clip.trimEnd as number) : clip.duration;
  const hasCurve = clipHasRateAutomation(clip);
  const rate = getClipPlaybackRate(clip);

  for (const marker of clip.syncMarkers ?? []) {
    if (Number.isFinite(marker.time) && marker.time >= 0) {
      times.add(marker.time);
    }
  }

  for (const beat of clip.beatTimestamps ?? []) {
    if (!Number.isFinite(beat) || beat < trimStart || beat > trimEnd) continue;
    const local = hasCurve
      ? outputLocalAtSourceOffset(clip, beat - trimStart)
      : (beat - trimStart) / rate;
    if (local >= 0) times.add(local);
  }

  for (const marker of masterMarkers) {
    if (!Number.isFinite(marker.time)) continue;
    const local = marker.time - clipOutputStart;
    if (local >= 0) times.add(local);
  }

  return [...times].sort((a, b) => a - b);
}

/** Snap output-local seconds to the nearest marker when within threshold. */
export function snapOutputLocalToMarkers(
  t: number,
  snapTimes: number[],
  thresholdSec = SPEED_KEYFRAME_SNAP_THRESHOLD_SEC,
): number {
  if (!snapTimes.length || !Number.isFinite(t)) return t;

  let best = t;
  let bestDist = thresholdSec;
  for (const candidate of snapTimes) {
    const dist = Math.abs(candidate - t);
    if (dist <= bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}
