/**
 * Intercut (strobe / flash-cut) slice planning for FFmpeg concat demuxer.
 *
 * Each slice references a source inpoint/outpoint on clip A or B.
 *
 * `sourceClock`:
 * - `freezeHidden` (default) — only the visible source advances; the hidden
 *   clip freezes and resumes. Offscreen frames are kept for later cuts.
 * - `parallel` — both sources track output wall-clock time. Cutting to B at
 *   output t shows B at trimStart+t (offscreen time is discarded).
 *
 * `consumeMode`:
 * - `targetDuration` — stop after the requested swap duration (or when a source
 *   runs out, whichever first).
 * - `entireSources` — keep cutting until the material budget is drained:
 *   freezeHidden → len(A)+len(B); parallel → max(len(A), len(B)).
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

/**
 * How much source material the intercut consumes.
 * - `targetDuration` — fill `automation.totalDurationSec` (default).
 * - `entireSources` — run until the material budget for `sourceClock` is drained.
 */
export type IntercutConsumeMode = 'targetDuration' | 'entireSources';

/**
 * How each source playhead advances while the other is on screen.
 * - `freezeHidden` — pause the offscreen clip (keeps its frames for later).
 * - `parallel` — both clocks follow output time (offscreen frames skipped).
 */
export type IntercutSourceClock = 'freezeHidden' | 'parallel';

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
  /**
   * Material budget. Default `targetDuration`. With `entireSources`, the
   * frequency ramp uses the full material budget as its time base (and ignores
   * `automation.totalDurationSec` for the swap length).
   */
  consumeMode?: IntercutConsumeMode;
  /** Playhead policy. Default `freezeHidden`. */
  sourceClock?: IntercutSourceClock;
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
  sourceClock: IntercutSourceClock,
): { slice: IntercutSlice; actual: number; offsetA: number; offsetB: number } | null {
  if (slot === 'A') {
    const inpoint = offsetA;
    const outpoint = Math.min(offsetA + sliceDuration, sourceA.trimEnd);
    const actual = outpoint - inpoint;
    if (actual <= 1e-9) return null;
    if (sourceClock === 'parallel') {
      // Both clocks advance with wall time; B skips the same interval.
      return {
        slice: { slot, inpoint, outpoint },
        actual,
        offsetA: outpoint,
        offsetB: Math.min(offsetB + actual, sourceB.trimEnd),
      };
    }
    return { slice: { slot, inpoint, outpoint }, actual, offsetA: outpoint, offsetB };
  }
  const inpoint = offsetB;
  const outpoint = Math.min(offsetB + sliceDuration, sourceB.trimEnd);
  const actual = outpoint - inpoint;
  if (actual <= 1e-9) return null;
  if (sourceClock === 'parallel') {
    return {
      slice: { slot, inpoint, outpoint },
      actual,
      offsetA: Math.min(offsetA + actual, sourceA.trimEnd),
      offsetB: outpoint,
    };
  }
  return { slice: { slot, inpoint, outpoint }, actual, offsetA, offsetB: outpoint };
}

/** Remaining media on a source for the given clock policy. */
function remainingForClock(
  source: IntercutSourceBounds,
  offset: number,
  sourceClock: IntercutSourceClock,
  wallTimeSec: number,
): number {
  if (sourceClock === 'parallel') {
    // Wall clock maps trimStart + wallTime → source time.
    return Math.max(0, sourceAvailableSec(source) - wallTimeSec);
  }
  return remainingOn(source, offset);
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

/** Trimmed length available on a source. */
export function sourceAvailableSec(source: IntercutSourceBounds): number {
  return Math.max(0, source.trimEnd - source.trimStart);
}

/**
 * Build alternating A/B slices for concat demuxer `inpoint` / `outpoint` entries.
 *
 * `sourceClock` controls whether the offscreen clip freezes (`freezeHidden`) or
 * both playheads track output wall time (`parallel`).
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
    consumeMode = 'targetDuration',
    sourceClock = 'freezeHidden',
  } = config;
  const beatInterval = beatSync ? medianBeatInterval(beatSync.beatTimestamps) : null;

  const availA = sourceAvailableSec(sourceA);
  const availB = sourceAvailableSec(sourceB);
  // freeze: all frames of both can appear → sum. parallel: shared wall clock → max.
  const entireBudget =
    sourceClock === 'parallel' ? Math.max(availA, availB) : availA + availB;

  const swapBudgetSec =
    consumeMode === 'entireSources'
      ? entireBudget
      : Math.max(0, automation.totalDurationSec);

  const frequencyAutomation: FrequencyAutomationConfig =
    consumeMode === 'entireSources'
      ? { ...automation, totalDurationSec: Math.max(swapBudgetSec, 1e-6) }
      : automation;

  if (swapBudgetSec <= 0 && tailDurationSec <= 0) return [];

  const slices: IntercutSlice[] = [];
  let outputTime = 0;
  let useA = startWithA;
  let offsetA = sourceA.trimStart;
  let offsetB = sourceB.trimStart;

  while (outputTime < swapBudgetSec - 1e-9) {
    const remA = remainingForClock(sourceA, offsetA, sourceClock, outputTime);
    const remB = remainingForClock(sourceB, offsetB, sourceClock, outputTime);

    if (consumeMode === 'entireSources' && remA <= 1e-9 && remB <= 1e-9) {
      break;
    }

    let sliceDuration = sliceDurationAtTime(
      frequencyAutomation,
      outputTime,
      minSliceSec,
      beatSync,
      beatInterval,
    );

    if (consumeMode === 'targetDuration') {
      const remaining = swapBudgetSec - outputTime;
      if (sliceDuration > remaining) {
        sliceDuration = remaining;
      }
    }
    if (sliceDuration <= 1e-9) break;

    let prefer: IntercutSlot = useA ? 'A' : 'B';
    const remainingSwap = swapBudgetSec - outputTime;
    const isLastIntercutSlice =
      consumeMode === 'targetDuration' && remainingSwap - sliceDuration <= 1e-9;

    if (isLastIntercutSlice && forceFinalClip !== 'auto') {
      prefer = forceFinalClip;
    }

    let slot: IntercutSlot = prefer;
    // Steal when preferred is empty: always in parallel (fill wall time), when
    // draining full sources, or on a forced last landing.
    const maySteal =
      sourceClock === 'parallel' ||
      consumeMode === 'entireSources' ||
      (isLastIntercutSlice && forceFinalClip !== 'auto');

    if (slot === 'A' && remA <= 1e-9 && remB > 1e-9) {
      if (maySteal) slot = 'B';
      else break;
    } else if (slot === 'B' && remB <= 1e-9 && remA > 1e-9) {
      if (maySteal) slot = 'A';
      else break;
    }

    let taken = takeSlice(
      slot,
      sliceDuration,
      offsetA,
      offsetB,
      sourceA,
      sourceB,
      sourceClock,
    );
    if (!taken && isLastIntercutSlice && forceFinalClip !== 'auto') {
      slot = slot === 'A' ? 'B' : 'A';
      taken = takeSlice(
        slot,
        sliceDuration,
        offsetA,
        offsetB,
        sourceA,
        sourceB,
        sourceClock,
      );
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
    const rem =
      landing === 'A'
        ? remainingForClock(sourceA, offsetA, sourceClock, outputTime)
        : remainingForClock(sourceB, offsetB, sourceClock, outputTime);
    const tail = Math.min(tailDurationSec, rem);
    if (tail > 1e-9) {
      const last = slices[slices.length - 1];
      if (last && last.slot === landing && sourceClock === 'freezeHidden') {
        // Contiguous resume on the same source — extend the last slice.
        last.outpoint += tail;
        if (landing === 'A') offsetA += tail;
        else offsetB += tail;
      } else if (last && last.slot === landing && sourceClock === 'parallel') {
        // Parallel: extend only if the landing source still has wall-time media.
        last.outpoint += tail;
        offsetA = Math.min(offsetA + tail, sourceA.trimEnd);
        offsetB = Math.min(offsetB + tail, sourceB.trimEnd);
      } else {
        const taken = takeSlice(
          landing,
          tail,
          offsetA,
          offsetB,
          sourceA,
          sourceB,
          sourceClock,
        );
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

/**
 * True when every slice is long enough that stream-copy *might* be keyframe-safe.
 * Intercut generation still re-encodes: alternating multi-source `inpoint` cuts
 * are almost never on keyframes, and stream-copy outputs often fail to load in
 * browsers ("Could not load media duration").
 */
export function canUseStreamCopyForIntercut(slices: IntercutSlice[]): boolean {
  if (slices.length === 0) return false;
  return slices.every(
    (s) => s.outpoint - s.inpoint >= INTERCUT_MIN_STREAM_COPY_SLICE_SEC,
  );
}

/** Shift slice times so 0 is each source's trimStart (after trim-window normalize). */
export function remapIntercutSlicesToTrimOrigin(
  slices: IntercutSlice[],
  trimStartA: number,
  trimStartB: number,
): IntercutSlice[] {
  return slices.map((slice) => {
    const base = slice.slot === 'A' ? trimStartA : trimStartB;
    return {
      slot: slice.slot,
      inpoint: Math.max(0, slice.inpoint - base),
      outpoint: Math.max(0, slice.outpoint - base),
    };
  });
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
  options?: {
    consumeMode?: IntercutConsumeMode;
    sourceClock?: IntercutSourceClock;
    sourceA?: IntercutSourceBounds;
    sourceB?: IntercutSourceBounds;
  },
): number {
  const consumeMode = options?.consumeMode ?? 'targetDuration';
  const sourceClock = options?.sourceClock ?? 'freezeHidden';
  if (consumeMode === 'entireSources' && options?.sourceA && options?.sourceB) {
    const availA = sourceAvailableSec(options.sourceA);
    const availB = sourceAvailableSec(options.sourceB);
    const budget = sourceClock === 'parallel' ? Math.max(availA, availB) : availA + availB;
    return budget + Math.max(0, tailDurationSec);
  }
  return Math.max(0, automation.totalDurationSec) + Math.max(0, tailDurationSec);
}

export function intercutShortageMessage(
  slices: IntercutSlice[],
  requestedSec: number,
  sourceA: IntercutSourceBounds,
  sourceB: IntercutSourceBounds,
  consumeMode: IntercutConsumeMode = 'targetDuration',
  sourceClock: IntercutSourceClock = 'freezeHidden',
): string | null {
  if (consumeMode === 'entireSources') {
    if (slices.length === 0) {
      const avail = sourceAvailableSec(sourceA) + sourceAvailableSec(sourceB);
      if (avail <= 1e-9) {
        return 'Both clips have zero trimmed duration — nothing to intercut.';
      }
      return 'Intercut produced zero slices — check clip durations and automation settings.';
    }
    const actual = intercutOutputDuration(slices);
    const availA = sourceAvailableSec(sourceA);
    const availB = sourceAvailableSec(sourceB);
    const budget = sourceClock === 'parallel' ? Math.max(availA, availB) : availA + availB;
    if (actual >= budget - 1e-3) return null;
    if (sourceClock === 'parallel') {
      return (
        `Could not cover full dual-clock span (${actual.toFixed(2)}s of ` +
        `${budget.toFixed(2)}s). Check frequency / min slice settings.`
      );
    }
    const usedA = slices
      .filter((s) => s.slot === 'A')
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
    const usedB = slices
      .filter((s) => s.slot === 'B')
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
    return (
      `Could not place all source material (${(usedA + usedB).toFixed(2)}s of ` +
      `${(availA + availB).toFixed(2)}s used). Check frequency / min slice settings.`
    );
  }

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
  const availA = sourceAvailableSec(sourceA);
  const availB = sourceAvailableSec(sourceB);
  const exhausted =
    usedA >= availA - 1e-3 && availA <= availB ? 'A' : usedB >= availB - 1e-3 ? 'B' : 'A';

  return (
    `Requested ${requestedSec.toFixed(2)}s intercut but sources only cover ${actual.toFixed(2)}s ` +
    `(clip ${exhausted} ran out of trimmed material). Shorten the duration or use longer clips.`
  );
}
