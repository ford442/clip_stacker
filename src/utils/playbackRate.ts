/**
 * Constant per-clip playback rate (time-stretch) helpers.
 *
 * Output timeline duration = trimmedSourceDuration / rate.
 * Video uses FFmpeg setpts; audio uses pitch-preserving atempo chains.
 */

import type { Clip } from '../types';

export const DEFAULT_CLIP_PLAYBACK_RATE = 1;
/** Sanitize / engine floor (Inspector UI may use a tighter max). */
export const MIN_CLIP_PLAYBACK_RATE = 0.25;
export const MAX_CLIP_PLAYBACK_RATE = 4;

/** FFmpeg `atempo` accepts 0.5–100.0 per filter instance. */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 100;

export function clampClipPlaybackRate(rate: number | undefined): number {
  const value = rate ?? DEFAULT_CLIP_PLAYBACK_RATE;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CLIP_PLAYBACK_RATE;
  return Math.min(MAX_CLIP_PLAYBACK_RATE, Math.max(MIN_CLIP_PLAYBACK_RATE, value));
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

/** Map output-local clip elapsed time → source media time (seconds). */
export function clipSourceTimeAtLocal(
  clip: Pick<Clip, 'trimStart' | 'playbackRate'>,
  localElapsed: number,
): number {
  return clip.trimStart + Math.max(0, localElapsed) * getClipPlaybackRate(clip);
}
