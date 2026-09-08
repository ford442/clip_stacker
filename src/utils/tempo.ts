/**
 * Tempo / beatmatching math.
 *
 * Pure functions over beat timestamps (seconds). No DOM, no WASM — the offline
 * analyzer, the Inspector beatmatch panel and the tests all share these.
 *
 * Tempo is treated as octave-ambiguous: 80 and 160 BPM describe the same pulse
 * grid, so candidate tempi are folded into a single musical window before they
 * are compared, and match rates are picked from the octave nearest 1×.
 */

import type { Clip } from '../types';
import { clampClipPlaybackRate, roundPlaybackRate } from './playbackRate';

/** Musical window candidate tempi are folded into. */
export const MIN_TEMPO_BPM = 70;
export const MAX_TEMPO_BPM = 180;

/** Inter-onset intervals outside this range cannot be a beat at any octave. */
const MIN_IOI_SEC = 60 / MAX_TEMPO_BPM;
const MAX_IOI_SEC = 60 / MIN_TEMPO_BPM;

/** Relative BPM distance treated as "the same tempo" when clustering. */
const CLUSTER_TOLERANCE = 0.04;
/** Relative median deviation at which tightness confidence reaches 0. */
const TIGHTNESS_FLOOR = 0.05;

export interface TempoEstimate {
  /** Folded BPM in [MIN_TEMPO_BPM, MAX_TEMPO_BPM], or null when undecidable. */
  bpm: number | null;
  /** 0–1 — how tightly the inter-onset intervals agree on that BPM. */
  confidence: number;
  /** First beat time that fits the chosen grid, or null. */
  offsetSec: number | null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function sortedCopy(values: number[]): number[] {
  return values.slice().sort((a, b) => a - b);
}

/**
 * Fold an interval into the musical window by at most one octave in each
 * direction. Returns null when even the folded interval is out of range.
 */
function foldIoiToWindow(ioi: number): number | null {
  if (!Number.isFinite(ioi) || ioi <= 0) return null;
  if (ioi >= MIN_IOI_SEC && ioi <= MAX_IOI_SEC) return ioi;
  if (ioi > MAX_IOI_SEC) {
    const halved = ioi / 2;
    return halved >= MIN_IOI_SEC && halved <= MAX_IOI_SEC ? halved : null;
  }
  const doubled = ioi * 2;
  return doubled >= MIN_IOI_SEC && doubled <= MAX_IOI_SEC ? doubled : null;
}

/**
 * BPM + confidence from onset times by clustering octave-folded inter-onset
 * intervals. More robust than a raw median IOI: a handful of missed or doubled
 * onsets no longer drags the estimate off the dominant pulse.
 */
export function clusterIoiBpm(beatTimes: number[]): TempoEstimate {
  const beats = sortedCopy(
    beatTimes.filter((t) => Number.isFinite(t) && t >= 0),
  );
  if (beats.length < 2) {
    return { bpm: null, confidence: 0, offsetSec: beats[0] ?? null };
  }

  const candidates: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const folded = foldIoiToWindow(beats[i]! - beats[i - 1]!);
    if (folded != null) candidates.push(60 / folded);
  }
  if (candidates.length === 0) {
    return { bpm: null, confidence: 0, offsetSec: beats[0]! };
  }

  // Largest set of candidate tempi within CLUSTER_TOLERANCE of a seed.
  const ordered = sortedCopy(candidates);
  let best: number[] = [];
  for (const seed of ordered) {
    const members = ordered.filter(
      (bpm) => Math.abs(bpm - seed) / seed <= CLUSTER_TOLERANCE,
    );
    if (members.length > best.length) best = members;
  }
  if (best.length === 0) best = ordered;

  const bpm = median(best);
  const deviations = sortedCopy(best.map((v) => Math.abs(v - bpm) / bpm));
  const tightness = clamp01(1 - median(deviations) / TIGHTNESS_FLOOR);
  const support = best.length / ordered.length;
  const confidence = clamp01(tightness * (0.5 + 0.5 * support));

  return { bpm, confidence, offsetSec: gridOffsetSec(beats, bpm) };
}

/**
 * First beat whose spacing to the next beat matches the chosen grid (at any
 * octave). Falls back to the earliest beat.
 */
function gridOffsetSec(sortedBeats: number[], bpm: number): number {
  const period = 60 / bpm;
  for (let i = 1; i < sortedBeats.length; i++) {
    const folded = foldIoiToWindow(sortedBeats[i]! - sortedBeats[i - 1]!);
    if (folded == null) continue;
    if (Math.abs(folded - period) / period <= CLUSTER_TOLERANCE) {
      return sortedBeats[i - 1]!;
    }
  }
  return sortedBeats[0]!;
}

/**
 * Playback rate that makes `followerBpm` line up with `targetBpm`.
 *
 * Octave-equivalent rates (½×, 2×, …) all beatmatch, so the one closest to 1×
 * wins — that keeps the picture watchable and the result inside the engine's
 * 0.25–4 rate range even for extreme tempo pairs.
 */
export function matchRate(followerBpm: number, targetBpm: number): number {
  if (!(followerBpm > 0) || !(targetBpm > 0)) return 1;
  const ratio = targetBpm / followerBpm;

  let best: number | null = null;
  for (let octave = -2; octave <= 2; octave++) {
    const rate = ratio * 2 ** octave;
    if (rate !== clampClipPlaybackRate(rate)) continue;
    if (best == null) {
      best = rate;
      continue;
    }
    const delta = Math.abs(Math.log(rate)) - Math.abs(Math.log(best));
    // Prefer the faster octave on an exact tie so the pick is deterministic.
    if (delta < -1e-9 || (Math.abs(delta) <= 1e-9 && rate > best)) best = rate;
  }

  return roundPlaybackRate(best ?? ratio);
}

/** Timeline seconds the follower must move to land on the target beat. */
export function phaseDeltaSec(
  followerBeatAbs: number,
  targetBeatAbs: number,
): number {
  if (!Number.isFinite(followerBeatAbs) || !Number.isFinite(targetBeatAbs)) {
    return 0;
  }
  return targetBeatAbs - followerBeatAbs;
}

/** Nearest beat to `timeSec`; returns `timeSec` unchanged when there are none. */
export function snapToNearestBeat(timeSec: number, beats: number[]): number {
  if (!Number.isFinite(timeSec)) return timeSec;
  let best = timeSec;
  let bestDist = Infinity;
  for (const beat of beats) {
    if (!Number.isFinite(beat)) continue;
    const dist = Math.abs(beat - timeSec);
    if (dist < bestDist) {
      bestDist = dist;
      best = beat;
    }
  }
  return best;
}

/** Most recent taps used for a tap-tempo estimate. */
const TAP_WINDOW = 8;
const MIN_TAPS = 4;

/**
 * BPM from manual taps (seconds). Uses the last {@link TAP_WINDOW} presses so a
 * drifting tapper converges; returns null until there are enough usable gaps.
 */
export function tapTempo(pressTimesSec: number[]): number | null {
  const taps = pressTimesSec
    .filter((t) => Number.isFinite(t))
    .slice(-TAP_WINDOW);
  if (taps.length < MIN_TAPS) return null;

  const intervals: number[] = [];
  for (let i = 1; i < taps.length; i++) {
    const dt = taps[i]! - taps[i - 1]!;
    if (dt > 0.2 && dt < 2) intervals.push(dt);
  }
  if (intervals.length === 0) return null;
  return 60 / median(sortedCopy(intervals));
}

/** Effective BPM for a clip: the manual override wins over the detected value. */
export function getClipBpm(
  clip: Pick<Clip, 'bpmOverride' | 'bpmEstimate'> | null | undefined,
): number | null {
  if (!clip) return null;
  const override = Number(clip.bpmOverride);
  if (Number.isFinite(override) && override > 0) return override;
  const estimate = Number(clip.bpmEstimate);
  if (Number.isFinite(estimate) && estimate > 0) return estimate;
  return null;
}

/** Coarse label for a 0–1 confidence value. */
export function confidenceLabel(confidence: number | undefined): 'Low' | 'Med' | 'High' {
  const value = confidence ?? 0;
  if (value >= 0.7) return 'High';
  if (value >= 0.4) return 'Med';
  return 'Low';
}
