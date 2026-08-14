/**
 * Intercut (strobe / flash-cut) slice planning for FFmpeg concat demuxer.
 *
 * Each slice references a source inpoint/outpoint on clip A or B. Source offsets
 * advance independently — output timeline position must NOT be used as inpoint.
 */

import type { Keyframe, KeyframeEasing } from './keyframes';
import { sampleKeyframes } from './keyframes';

export type IntercutSlot = 'A' | 'B';

export interface IntercutSourceBounds {
  /** Source media time where readable content starts (seconds). */
  trimStart: number;
  /** Source media time where readable content ends (seconds, exclusive). */
  trimEnd: number;
}

export interface IntercutSlice {
  slot: IntercutSlot;
  inpoint: number;
  outpoint: number;
}

export interface FrequencyAutomationConfig {
  /** Total output duration of the generated intercut (seconds). */
  totalDurationSec: number;
  startFrequencyHz: number;
  endFrequencyHz: number;
  /** Optional Hz keyframes over [0, totalDurationSec]. Overrides start/end ramp. */
  frequencyKeyframes?: Keyframe[];
  /** Easing for the implicit start→end ramp when frequencyKeyframes is omitted. */
  easing?: KeyframeEasing;
}

export interface IntercutBeatSyncConfig {
  /** Source-media beat times (seconds). Typically `beatsInTrimWindow(clip)`. */
  beatTimestamps: number[];
  /**
   * Fixed beats-per-cut. When omitted, stride is derived from the sampled
   * frequency vs the median beat interval (1 = cut on every beat).
   */
  stride?: number;
}

export type IntercutFinalClip = IntercutSlot | 'auto';

export interface BuildIntercutSlicesConfig {
  sourceA: IntercutSourceBounds;
  sourceB: IntercutSourceBounds;
  automation: FrequencyAutomationConfig;
  /** Floor on slice length; caps max Hz. Default one 60 fps frame. */
  minSliceSec?: number;
  /** First visible slice comes from clip A when true (default). */
  startWithA?: boolean;
  /** Optional musical cut grid; falls back to raw Hz when beats are too sparse. */
  beatSync?: IntercutBeatSyncConfig;
  /**
   * Last slice of the swapping phase. `auto` (default) keeps strict A/B
   * alternation; `A`/`B` override that last slot when the source still has
   * trimmed material.
   */
  forceFinalClip?: IntercutFinalClip;
  /**
   * Extra output seconds after the swapping phase, played only from the
   * landing clip (forced slot, else the last alternating slice).
   */
  tailDurationSec?: number;
}

/** Minimum slice length (seconds) before stream-copy concat is considered safe. */
export const INTERCUT_MIN_STREAM_COPY_SLICE_SEC = 0.5;

/**
 * Sample cut frequency (Hz) at a point on the output timeline.
 */
export function frequencyHzAtTime(
  automation: FrequencyAutomationConfig,
  outputTimeSec: number,
): number {
  const { totalDurationSec, startFrequencyHz, endFrequencyHz, frequencyKeyframes, easing } =
    automation;

  if (frequencyKeyframes?.length) {
    return sampleKeyframes(frequencyKeyframes, outputTimeSec, startFrequencyHz);
  }

  const track: Keyframe[] = [
    { t: 0, value: startFrequencyHz, easing },
    { t: totalDurationSec, value: endFrequencyHz },
  ];
  return sampleKeyframes(track, outputTimeSec, startFrequencyHz);
}

/** Convert cut frequency (Hz) to seconds per cut. */
export function hzToSecondsPerCut(hz: number): number {
  return 1 / Math.max(hz, 0.01);
}

/** Convert seconds per cut to frequency (Hz). */
export function secondsPerCutToHz(secondsPerCut: number): number {
  return 1 / Math.max(secondsPerCut, 0.01);
}

/** Median interval between consecutive beat timestamps, or null. */
export function medianBeatInterval(beatTimestamps: number[]): number | null {
  const beats = beatTimestamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (beats.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i]! - beats[i - 1]!;
    if (d > 1e-6) intervals.push(d);
  }
  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  return intervals.length % 2 === 1
    ? intervals[mid]!
    : (intervals[mid - 1]! + intervals[mid]!) / 2;
}

/**
 * Beats per cut for a target frequency. `1` means cut on every beat.
 * When Hz is faster than the beat grid, still returns 1 (caller may use raw Hz).
 */
export function beatStrideForFrequency(hz: number, medianIntervalSec: number): number {
  const beatsPerSec = 1 / Math.max(medianIntervalSec, 1e-6);
  return Math.max(1, Math.round(beatsPerSec / Math.max(hz, 0.1)));
}

function remainingOn(source: IntercutSourceBounds, offset: number): number {
  return Math.max(0, source.trimEnd - offset);
}

function takeSlice(
  slot: IntercutSlot,
  sliceDuration: number,
  offsetA: number,
  offsetB: number,
  sourceA: IntercutSourceBounds,
  sourceB: IntercutSourceBounds,
): { slice: IntercutSlice; actual: number; offsetA: number; offsetB: number } | null {
  if (slot === 'A') {
    const inpoint = offsetA;
    const outpoint = Math.min(offsetA + sliceDuration, sourceA.trimEnd);
    const actual = outpoint - inpoint;
    if (actual <= 1e-9) return null;
    return { slice: { slot, inpoint, outpoint }, actual, offsetA: outpoint, offsetB };
  }
  const inpoint = offsetB;
  const outpoint = Math.min(offsetB + sliceDuration, sourceB.trimEnd);
  const actual = outpoint - inpoint;
  if (actual <= 1e-9) return null;
  return { slice: { slot, inpoint, outpoint }, actual, offsetA, offsetB: outpoint };
}

function sliceDurationAtTime(
  automation: FrequencyAutomationConfig,
  outputTimeSec: number,
  minSliceSec: number,
  beatSync: IntercutBeatSyncConfig | undefined,
  beatInterval: number | null,
): number {
  const hz = frequencyHzAtTime(automation, outputTimeSec);
  const safeHz = Math.max(hz, 0.1);
  let sliceDuration = Math.max(1 / safeHz, minSliceSec);

  if (beatSync && beatInterval != null) {
    const hzDuration = 1 / safeHz;
    // Faster than every-beat: keep the Hz strobe so musical mode can still accelerate.
    if (hzDuration < beatInterval * 0.5) {
      return sliceDuration;
    }
    const stride = beatSync.stride ?? beatStrideForFrequency(safeHz, beatInterval);
    sliceDuration = Math.max(stride * beatInterval, minSliceSec);
  }

  return sliceDuration;
}

/**
 * Build alternating A/B slices for concat demuxer `inpoint` / `outpoint` entries.
 */
export function buildIntercutSlices(config: BuildIntercutSlicesConfig): IntercutSlice[] {
  const {
    sourceA,
    sourceB,
    automation,
    minSliceSec = 1 / 60,
    startWithA = true,
    beatSync,
    forceFinalClip = 'auto',
    tailDurationSec = 0,
  } = config;
  const beatInterval = beatSync ? medianBeatInterval(beatSync.beatTimestamps) : null;

  const { totalDurationSec } = automation;
  if (totalDurationSec <= 0 && tailDurationSec <= 0) return [];

  const slices: IntercutSlice[] = [];
  let outputTime = 0;
  let useA = startWithA;
  let offsetA = sourceA.trimStart;
  let offsetB = sourceB.trimStart;

  while (outputTime < totalDurationSec - 1e-9) {
    let sliceDuration = sliceDurationAtTime(
      automation,
      outputTime,
      minSliceSec,
      beatSync,
      beatInterval,
    );

    const remaining = totalDurationSec - outputTime;
    if (sliceDuration > remaining) {
      sliceDuration = remaining;
    }
    if (sliceDuration <= 1e-9) break;

    const isLastIntercutSlice = remaining - sliceDuration <= 1e-9;
    let slot: IntercutSlot =
      isLastIntercutSlice && forceFinalClip !== 'auto'
        ? forceFinalClip
        : useA
          ? 'A'
          : 'B';

    let taken = takeSlice(slot, sliceDuration, offsetA, offsetB, sourceA, sourceB);
    if (!taken && isLastIntercutSlice && forceFinalClip !== 'auto') {
      // Forced landing clip is exhausted — fill remaining swap time from the other.
      slot = slot === 'A' ? 'B' : 'A';
      taken = takeSlice(slot, sliceDuration, offsetA, offsetB, sourceA, sourceB);
    }
    if (!taken) break;

    slices.push(taken.slice);
    offsetA = taken.offsetA;
    offsetB = taken.offsetB;
    outputTime += taken.actual;
    useA = !useA;
  }

  const landing: IntercutSlot =
    forceFinalClip !== 'auto'
      ? forceFinalClip
      : slices.length > 0
        ? slices[slices.length - 1]!.slot
        : startWithA
          ? 'A'
          : 'B';

  if (tailDurationSec > 1e-9) {
    const rem = landing === 'A' ? remainingOn(sourceA, offsetA) : remainingOn(sourceB, offsetB);
    const tail = Math.min(tailDurationSec, rem);
    if (tail > 1e-9) {
      const last = slices[slices.length - 1];
      if (last && last.slot === landing) {
        last.outpoint += tail;
      } else {
        const taken = takeSlice(landing, tail, offsetA, offsetB, sourceA, sourceB);
        if (taken) slices.push(taken.slice);
      }
    }
  }

  return slices;
}

/**
 * FFmpeg concat demuxer v2 playlist (file + inpoint + outpoint per slice).
 */
export function buildConcatPlaylist(
  slices: IntercutSlice[],
  fileA: string,
  fileB: string,
): string {
  const lines: string[] = [];
  for (const slice of slices) {
    const file = slice.slot === 'A' ? fileA : fileB;
    const escaped = file.replace(/'/g, "'\\''");
    lines.push(`file '${escaped}'`);
    lines.push(`inpoint ${slice.inpoint.toFixed(6)}`);
    lines.push(`outpoint ${slice.outpoint.toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** True when every slice is long enough for keyframe-safe stream copy. */
export function canUseStreamCopyForIntercut(slices: IntercutSlice[]): boolean {
  if (slices.length === 0) return false;
  return slices.every(
    (s) => s.outpoint - s.inpoint >= INTERCUT_MIN_STREAM_COPY_SLICE_SEC,
  );
}

/** Sum of slice durations on the output timeline. */
export function intercutOutputDuration(slices: IntercutSlice[]): number {
  return slices.reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
}

/**
 * Explain why a planned intercut is shorter than the requested duration, or
 * `null` when the plan covers the request.
 */
/** Swapping-phase duration plus optional post-strobe tail. */
export function requestedIntercutDuration(
  automation: Pick<FrequencyAutomationConfig, 'totalDurationSec'>,
  tailDurationSec = 0,
): number {
  return Math.max(0, automation.totalDurationSec) + Math.max(0, tailDurationSec);
}

export function intercutShortageMessage(
  slices: IntercutSlice[],
  requestedSec: number,
  sourceA: IntercutSourceBounds,
  sourceB: IntercutSourceBounds,
): string | null {
  if (requestedSec <= 0) return 'Intercut duration must be greater than zero.';
  const actual = intercutOutputDuration(slices);
  if (slices.length === 0) {
    return 'Intercut produced zero slices — check clip durations and automation settings.';
  }
  if (actual >= requestedSec - 1e-3) return null;

  const usedA = slices
    .filter((s) => s.slot === 'A')
    .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
  const usedB = slices
    .filter((s) => s.slot === 'B')
    .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
  const availA = Math.max(0, sourceA.trimEnd - sourceA.trimStart);
  const availB = Math.max(0, sourceB.trimEnd - sourceB.trimStart);
  const exhausted =
    usedA >= availA - 1e-3 && availA <= availB ? 'A' : usedB >= availB - 1e-3 ? 'B' : 'A';

  return (
    `Requested ${requestedSec.toFixed(2)}s intercut but sources only cover ${actual.toFixed(2)}s ` +
    `(clip ${exhausted} ran out of trimmed material). Shorten the duration or use longer clips.`
  );
}
