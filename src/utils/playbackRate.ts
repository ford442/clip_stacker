/**
 * Constant per-clip playback rate (time-stretch) helpers.
 *
 * Output timeline duration = trimmedSourceDuration / rate.
 * Video uses FFmpeg setpts; audio uses pitch-preserving atempo chains.
 * Variable rate curves: see `timeRemap.ts` (∫ rate dt).
 */

import type { Clip } from '../types';
import { MIN_CLIP_DURATION } from './media';

export const DEFAULT_CLIP_PLAYBACK_RATE = 1;
/** Sanitize / engine floor (Inspector UI may use a tighter max). */
export const MIN_CLIP_PLAYBACK_RATE = 0.25;
export const MAX_CLIP_PLAYBACK_RATE = 4;

/** Inspector slider / nudge ceiling (matches sanitize max for lip-sync headroom). */
export const UI_MAX_CLIP_PLAYBACK_RATE = 4;

/** Fine nudge for lip-sync tuning while listening to music. */
export const PLAYBACK_RATE_NUDGE_FINE = 0.01;
/** Coarser nudge for quicker adjustments. */
export const PLAYBACK_RATE_NUDGE_COARSE = 0.05;

/** FFmpeg `atempo` accepts 0.5–100.0 per filter instance. */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 100;

export function clampClipPlaybackRate(rate: number | undefined): number {
  const value = rate ?? DEFAULT_CLIP_PLAYBACK_RATE;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CLIP_PLAYBACK_RATE;
  return Math.min(MAX_CLIP_PLAYBACK_RATE, Math.max(MIN_CLIP_PLAYBACK_RATE, value));
}

/** Round then clamp — keeps Inspector / fit-to-duration rates stable. */
export function roundPlaybackRate(rate: number, decimals = 3): number {
  const factor = 10 ** Math.max(0, decimals);
  return clampClipPlaybackRate(Math.round(rate * factor) / factor);
}

export function getClipPlaybackRate(
  clip: Pick<Clip, 'playbackRate'> | number | undefined,
): number {
  if (typeof clip === 'number' || clip == null) {
    return clampClipPlaybackRate(clip as number | undefined);
  }
  return clampClipPlaybackRate(clip.playbackRate);
}

export function clipHasPlaybackRateAdjustment(
  clip: Pick<Clip, 'playbackRate'>,
): boolean {
  return Math.abs(getClipPlaybackRate(clip) - DEFAULT_CLIP_PLAYBACK_RATE) > 1e-6;
}

/** Trimmed source media length in seconds (before time-stretch). */
export function getTrimmedSourceDuration(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration'>,
): number {
  const end = Number.isFinite(clip.trimEnd) ? (clip.trimEnd as number) : clip.duration;
  return Math.max(MIN_CLIP_DURATION, end - clip.trimStart);
}

/**
 * Rate that makes `trimmedSourceSec` occupy exactly `targetOutputSec` on the timeline.
 * Higher target → slower rate (stretch); shorter target → faster (compress).
 */
export function playbackRateForTargetDuration(
  trimmedSourceSec: number,
  targetOutputSec: number,
): number {
  if (!(trimmedSourceSec > 0) || !(targetOutputSec > 0)) {
    return DEFAULT_CLIP_PLAYBACK_RATE;
  }
  return roundPlaybackRate(trimmedSourceSec / targetOutputSec);
}

/** Output timeline seconds for a trimmed source length at `rate`. */
export function outputDurationForRate(
  trimmedSourceSec: number,
  rate: number,
): number {
  const r = clampClipPlaybackRate(rate);
  return Math.max(MIN_CLIP_DURATION, trimmedSourceSec / r);
}

export function nudgePlaybackRate(rate: number, delta: number): number {
  return roundPlaybackRate(clampClipPlaybackRate(rate) + delta);
}

/**
 * Rate so the trimmed source fills exactly `beatCount` beats at `bpm`.
 * Useful for fitting a lip-sync take to a music phrase (e.g. 8 beats).
 */
export function playbackRateToFitBeats(
  trimmedSourceSec: number,
  bpm: number,
  beatCount: number,
): number | null {
  if (!(trimmedSourceSec > 0) || !(bpm > 0) || !(beatCount > 0)) return null;
  const targetSec = (beatCount * 60) / bpm;
  return playbackRateForTargetDuration(trimmedSourceSec, targetSec);
}

/** How many beats the current output duration spans at `bpm`. */
export function beatsSpannedByDuration(outputSec: number, bpm: number): number {
  if (!(outputSec > 0) || !(bpm > 0)) return 0;
  return (outputSec * bpm) / 60;
}

/** Format a rate for FFmpeg filter args (trim trailing zeros). */
export function formatPlaybackRate(rate: number): string {
  const clamped = clampClipPlaybackRate(rate);
  const fixed = clamped.toFixed(6);
  return fixed.replace(/\.?0+$/, '') || '1';
}

/**
 * Pitch-preserving atempo chain for a speed multiplier.
 * Returns '' when rate ≈ 1; otherwise comma-joined `atempo=` segments
 * (e.g. 0.25 → `atempo=0.5,atempo=0.5`).
 */
export function buildAtempoChain(rate: number): string {
  let remaining = clampClipPlaybackRate(rate);
  if (Math.abs(remaining - 1) < 1e-6) return '';

  const factors: number[] = [];
  while (remaining < ATEMPO_MIN - 1e-9) {
    factors.push(ATEMPO_MIN);
    remaining /= ATEMPO_MIN;
  }
  while (remaining > ATEMPO_MAX + 1e-9) {
    factors.push(ATEMPO_MAX);
    remaining /= ATEMPO_MAX;
  }
  factors.push(remaining);
  return factors.map((f) => `atempo=${formatPlaybackRate(f)}`).join(',');
}

/** `,atempo=…` segment to append inside an audio filter chain (or ''). */
export function audioTempoFilterSegment(rate: number): string {
  const chain = buildAtempoChain(rate);
  return chain ? `,${chain}` : '';
}

/**
 * Video PTS rescale after trim.
 * rate=1 → `setpts=PTS-STARTPTS`; otherwise `setpts=(PTS-STARTPTS)/rate`.
 */
export function videoSetptsFilter(rate: number): string {
  const r = clampClipPlaybackRate(rate);
  if (Math.abs(r - 1) < 1e-6) return 'setpts=PTS-STARTPTS';
  return `setpts=(PTS-STARTPTS)/${formatPlaybackRate(r)}`;
}

/** Map output-local elapsed → source time for **constant** rate only.
 * Variable curves: use `sourceTimeAtOutputLocal` from `timeRemap.ts`. */
export function clipSourceTimeAtLocal(
  clip: Pick<Clip, 'trimStart' | 'playbackRate'>,
  localElapsed: number,
): number {
  return clip.trimStart + Math.max(0, localElapsed) * getClipPlaybackRate(clip);
}
