/**
 * Non-destructive reverse. `Clip.reversed` plays the trim window backward.
 * Output duration is unchanged (speed and loops still apply on top).
 *
 * Picture: `sourceTimeAtOutputLocal` walks the trim from the end, and the
 * decoder cache in `reverseFrames.ts` serves those backward seeks a chunk
 * at a time. Sound: a reversed trim buffer (constant rate) or a flipped
 * WSOLA offset map (speed curve). FFmpeg fallback inserts `reverse` /
 * `areverse` immediately after the trim.
 */

import type { Clip } from '../types';

/** Half a millisecond inside the exclusive trim end, so the first reversed
 * frame is the last frame of the window rather than the one just past it. */
export const REVERSE_END_BIAS_SEC = 0.001;

export function clipIsReversed(
  clip: { reversed?: boolean } | null | undefined,
): boolean {
  return clip?.reversed === true;
}

/** FFmpeg filter inserted after `trim`, before `setpts`. Empty when forward. */
export function videoReversePrefix(clip: { reversed?: boolean }): string {
  return clipIsReversed(clip) ? 'reverse,' : '';
}

/** FFmpeg filter inserted after `atrim`, before `asetpts`. Empty when forward. */
export function audioReversePrefix(clip: { reversed?: boolean }): string {
  return clipIsReversed(clip) ? 'areverse,' : '';
}

/** Reverse samples in `[start, endExclusive)`. */
export function reverseChannelWindow(
  samples: ArrayLike<number>,
  start: number,
  endExclusive: number,
): Float32Array {
  const from = Math.max(0, start);
  const to = Math.max(from, endExclusive);
  const count = to - from;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const src = to - 1 - i;
    out[i] = src >= 0 && src < samples.length ? samples[src]! : 0;
  }
  return out;
}

/**
 * Trim window played backward. The result starts at the original trim end
 * and is `trim length` long, so a later `playbackRate` still shortens it
 * the same way a forward clip does.
 */
export function reverseTrimmedAudioBuffer(
  source: AudioBuffer,
  trimStart: number,
  trimEnd: number,
  ctx: BaseAudioContext,
): AudioBuffer | null {
  const sr = source.sampleRate;
  if (!(sr > 0)) return null;
  const start = Math.max(0, Math.floor(Math.max(0, trimStart) * sr));
  const endLimit = Number.isFinite(trimEnd) ? trimEnd : source.duration;
  const end = Math.min(source.length, Math.max(start, Math.ceil(endLimit * sr)));
  const frames = end - start;
  if (frames <= 0) return null;

  const channels = Math.max(1, source.numberOfChannels);
  const out = ctx.createBuffer(channels, frames, sr);
  for (let ch = 0; ch < channels; ch++) {
    const reversed = reverseChannelWindow(source.getChannelData(ch), start, end);
    out.getChannelData(ch).set(reversed);
  }
  return out;
}

/** Exclusive end of the trim window, in source seconds. */
export function trimmedSourceEnd(
  clip: Pick<Clip, 'trimStart' | 'trimEnd' | 'duration'>,
): number {
  const end = Number.isFinite(clip.trimEnd) ? (clip.trimEnd as number) : clip.duration;
  if (!Number.isFinite(end)) return clip.trimStart;
  return Math.max(clip.trimStart, end);
}
