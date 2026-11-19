/**
 * Exact frame arithmetic for timeline interchange.
 *
 * Every interchange time is an integer frame count at the sequence rate; this
 * module turns those into each format's notation without passing through a
 * float: FCPXML's rational seconds (`1001/30000s`), OTIO's `RationalTime`
 * (integer `value` at a `rate`), and back. A sequence rate is itself a
 * rational (`num / den` frames per second), so 29.97 is `30000 / 1001`.
 */

/** A frame rate as `num / den` frames per second (both positive integers). */
export interface FrameRate {
  num: number;
  den: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/** `frames / rate` as reduced rational seconds `[num, den]`. */
export function framesToRationalSeconds(frames: number, rate: FrameRate): [number, number] {
  const num = frames * rate.den;
  const den = rate.num;
  const g = gcd(num, den);
  return [num / g, den / g];
}

/** FCPXML time: `0s`, `5s` or `1001/30000s`. */
export function formatRationalSeconds(frames: number, rate: FrameRate): string {
  if (frames === 0) return '0s';
  const [num, den] = framesToRationalSeconds(frames, rate);
  return den === 1 ? `${num}s` : `${num}/${den}s`;
}

/** Parse FCPXML time (`5s`, `1001/30000s`, `0s`) into rational seconds; null when malformed. */
export function parseRationalSeconds(text: string | undefined | null): [number, number] | null {
  if (typeof text !== 'string') return null;
  const match = /^\s*(-?\d+)(?:\/(\d+))?s\s*$/.exec(text);
  if (!match) return null;
  const num = Number(match[1]);
  const den = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) return null;
  return [num, den];
}

/** Rational seconds → frames at `rate`, rounded to the nearest frame. */
export function rationalSecondsToFrames([num, den]: [number, number], rate: FrameRate): number {
  return Math.round((num * rate.num) / (den * rate.den));
}

/** FCPXML time → frames at `rate` (0 when absent or malformed). */
export function fcpTimeToFrames(text: string | undefined | null, rate: FrameRate): number {
  const parsed = parseRationalSeconds(text);
  return parsed ? rationalSecondsToFrames(parsed, rate) : 0;
}

/** The rate as a double, for formats that store it so (OTIO `rate`). */
export function rateToNumber(rate: FrameRate): number {
  return rate.num / rate.den;
}

/** Seconds → frames at `rate`, rounded to the nearest frame. */
export function secondsToFrames(seconds: number, rate: FrameRate): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round((seconds * rate.num) / rate.den);
}

/** Frames → seconds at `rate`. */
export function framesToSeconds(frames: number, rate: FrameRate): number {
  return (frames * rate.den) / rate.num;
}

/**
 * Frames at another rate (an OTIO `RationalTime` written by a tool that
 * used the media rate) → frames at `rate`.
 */
export function rescaleFrames(value: number, fromRate: number, rate: FrameRate): number {
  if (!Number.isFinite(value) || !(fromRate > 0)) return 0;
  return Math.round((value / fromRate) * rateToNumber(rate));
}

/** The frame duration as FCPXML writes it (`1/30s`, `1001/30000s`). */
export function frameDurationText(rate: FrameRate): string {
  return formatRationalSeconds(1, rate);
}
