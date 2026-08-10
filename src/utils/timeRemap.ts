/**
 * Variable-speed time remapping — integrate a playbackRate keyframe curve
 * to map output-local clip time → source media time.
 *
 * Keyframe times are **output-local** seconds within the clip (same convention
 * as volume/pan automation). Rate values are absolute speed multipliers
 * (1 = realtime). Source consumed over [0, T] is ∫₀ᵀ rate(τ) dτ.
 *
 * Reuses existing `Keyframe` — no parallel AutomationNode type.
 */

import type { Clip } from '../types';
import type { Keyframe } from './keyframes';
import { sampleKeyframes, sortKeyframes } from './keyframes';
import { MIN_CLIP_DURATION } from './media';
import {
  clampClipPlaybackRate,
  getClipPlaybackRate,
  getTrimmedSourceDuration,
} from './playbackRate';

const RATE_EPS = 1e-6;
const INTEGRAL_EPS = 1e-7;

export function clipHasRateAutomation(
  clip: Pick<Clip, 'automation'> | null | undefined,
): boolean {
  return (clip?.automation?.playbackRate?.length ?? 0) > 0;
}

/** Sample absolute playback rate at output-local time (clamped). */
export function samplePlaybackRateAt(
  clip: Pick<Clip, 'playbackRate' | 'automation'>,
  outputLocalT: number,
): number {
  const fallback = getClipPlaybackRate(clip);
  const track = clip.automation?.playbackRate;
  return clampClipPlaybackRate(sampleKeyframes(track, outputLocalT, fallback));
}

/**
 * Analytic integral of a piecewise-linear rate curve from 0 → outputLocalT.
 * Holds constant outside the first/last keyframe (matches sampleKeyframes).
 */
export function integrateRateToSourceOffset(
  keyframes: Keyframe[] | undefined,
  defaultRate: number,
  outputLocalT: number,
): number {
  const tEnd = Math.max(0, outputLocalT);
  if (tEnd <= 0) return 0;

  const rate0 = clampClipPlaybackRate(defaultRate);
  if (!keyframes?.length) return rate0 * tEnd;

  const track = sortKeyframes(keyframes).map((k) => ({
    t: k.t,
    value: clampClipPlaybackRate(k.value),
  }));

  if (track.length === 1) {
    return track[0].value * tEnd;
  }

  let integral = 0;
  let cursor = 0;

  // Before first keyframe: hold first value
  const first = track[0];
  if (tEnd <= first.t) {
    return first.value * tEnd;
  }
  if (first.t > 0) {
    const span = Math.min(first.t, tEnd) - cursor;
    integral += first.value * span;
    cursor = first.t;
  }

  for (let i = 0; i < track.length - 1 && cursor < tEnd - INTEGRAL_EPS; i++) {
    const a = track[i];
    const b = track[i + 1];
    const segEnd = Math.min(b.t, tEnd);
    if (segEnd <= cursor) continue;

    const span = b.t - a.t;
    if (span <= RATE_EPS) {
      integral += b.value * (segEnd - cursor);
      cursor = segEnd;
      continue;
    }

    // Integrate linear ramp a→b from cursor to segEnd
    const u0 = (cursor - a.t) / span;
    const u1 = (segEnd - a.t) / span;
    // ∫_{u0}^{u1} (a + (b-a)*u) * span du = span * [a*u + (b-a)*u²/2]_{u0}^{u1}
    const antideriv = (u: number) =>
      a.value * u + ((b.value - a.value) * u * u) / 2;
    integral += span * (antideriv(u1) - antideriv(u0));
    cursor = segEnd;
  }

  // After last keyframe: hold last value
  if (cursor < tEnd) {
    const last = track[track.length - 1];
    integral += last.value * (tEnd - cursor);
  }

  return Math.max(0, integral);
}

/** Source media time (seconds) at an output-local position within the clip. */
export function sourceTimeAtOutputLocal(
  clip: Pick<Clip, 'trimStart' | 'playbackRate' | 'automation'>,
  outputLocalT: number,
): number {
  const offset = integrateRateToSourceOffset(
    clip.automation?.playbackRate,
    getClipPlaybackRate(clip),
    outputLocalT,
  );
  return clip.trimStart + offset;
}

/**
 * Output duration that consumes exactly the trimmed source.
 * Solves ∫₀ᵀ rate(τ) dτ = sourceLen via binary search (piecewise-linear safe).
 */
export function outputDurationForSourceLength(
  clip: Pick<Clip, 'playbackRate' | 'automation'>,
  sourceLen: number,
): number {
  const len = Math.max(MIN_CLIP_DURATION, sourceLen);
  const defaultRate = getClipPlaybackRate(clip);
  const track = clip.automation?.playbackRate;

  if (!track?.length) {
    return Math.max(MIN_CLIP_DURATION, len / defaultRate);
  }

  // Upper bound: if min rate is MIN, duration ≤ sourceLen / MIN
  const minRate = Math.max(
    MIN_CLIP_DURATION,
    Math.min(
      defaultRate,
      ...track.map((k) => clampClipPlaybackRate(k.value)),
    ),
  );
  let lo = 0;
  let hi = Math.max(len / Math.max(minRate, 0.25) * 1.05, len * 4, MIN_CLIP_DURATION);

  // Expand hi until integral covers source
  for (let i = 0; i < 16; i++) {
    const consumed = integrateRateToSourceOffset(track, defaultRate, hi);
    if (consumed >= len - INTEGRAL_EPS) break;
    hi *= 2;
  }

  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const consumed = integrateRateToSourceOffset(track, defaultRate, mid);
    if (consumed < len) lo = mid;
    else hi = mid;
  }

  return Math.max(MIN_CLIP_DURATION, hi);
}

/**
 * Effective clip duration on the output timeline — respects constant rate and
 * variable playbackRate automation curves.
 */
export function remappedClipDuration(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation'>,
): number {
  const sourceLen = getTrimmedSourceDuration(clip);
  return outputDurationForSourceLength(clip, sourceLen);
}

/**
 * Dense samples of { outputLocal, sourceOffset, rate } for drawing the curve
 * and for offline audio processing.
 */
export function sampleRemapCurve(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration' | 'playbackRate' | 'automation'>,
  sampleCount = 64,
): Array<{ t: number; rate: number; sourceOffset: number }> {
  const duration = remappedClipDuration(clip);
  const n = Math.max(2, sampleCount);
  const points: Array<{ t: number; rate: number; sourceOffset: number }> = [];
  for (let i = 0; i < n; i++) {
    const t = (duration * i) / (n - 1);
    points.push({
      t,
      rate: samplePlaybackRateAt(clip, t),
      sourceOffset: integrateRateToSourceOffset(
        clip.automation?.playbackRate,
        getClipPlaybackRate(clip),
        t,
      ),
    });
  }
  return points;
}

/**
 * Inverse map: given source offset from trimStart, find output-local time.
 * Used for beat markers (source times → timeline pixels).
 */
export function outputLocalAtSourceOffset(
  clip: Pick<Clip, 'playbackRate' | 'automation'>,
  sourceOffset: number,
): number {
  const offset = Math.max(0, sourceOffset);
  if (offset <= 0) return 0;
  return outputDurationForSourceLength(clip, offset);
}
