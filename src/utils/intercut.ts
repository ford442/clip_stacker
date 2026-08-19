/**
 * Intercut (strobe / flash-cut) slice planning for FFmpeg concat demuxer.
 *
 * Each slice references a source inpoint/outpoint on clip A, B, or optional C.
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

export type IntercutSlot = 'A' | 'B' | 'C';

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
  /** Optional third source; when set, slices cycle A → B → C. */
  sourceC?: IntercutSourceBounds;
  automation: FrequencyAutomationConfig;
  /** Floor on slice length; caps max Hz. Default one 60 fps frame. */
  minSliceSec?: number;
  /** First visible slice comes from clip A when true (default). */
  startWithA?: boolean;
  /** Optional musical cut grid; falls back to raw Hz when beats are too sparse. */
  beatSync?: IntercutBeatSyncConfig;
  /**
   * Last slice of the swapping phase. `auto` (default) keeps strict A/B/C
   * cycling; `A`/`B`/`C` override that last slot when the source still has
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

type SlotOffsets = Partial<Record<IntercutSlot, number>>;
type SlotSources = Partial<Record<IntercutSlot, IntercutSourceBounds>>;

function takeSlice(
  slot: IntercutSlot,
  sliceDuration: number,
  offsets: SlotOffsets,
  sources: SlotSources,
  slots: IntercutSlot[],
  sourceClock: IntercutSourceClock,
): { slice: IntercutSlice; actual: number; offsets: SlotOffsets } | null {
  const source = sources[slot];
  const offset = offsets[slot];
  if (!source || offset == null) return null;
  const inpoint = offset;
  const outpoint = Math.min(offset + sliceDuration, source.trimEnd);
  const actual = outpoint - inpoint;
  if (actual <= 1e-9) return null;
  const next: SlotOffsets = { ...offsets };
  if (sourceClock === 'parallel') {
    for (const s of slots) {
      const src = sources[s];
      const off = offsets[s];
      if (!src || off == null) continue;
      next[s] = Math.min(off + actual, src.trimEnd);
    }
  }
  next[slot] = outpoint;
  return { slice: { slot, inpoint, outpoint }, actual, offsets: next };
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

function remainingBySlot(
  slots: IntercutSlot[],
  sources: SlotSources,
  offsets: SlotOffsets,
  sourceClock: IntercutSourceClock,
  wallTimeSec: number,
): Record<IntercutSlot, number> {
  const rem = { A: 0, B: 0, C: 0 };
  for (const slot of slots) {
    const source = sources[slot];
    const offset = offsets[slot];
    if (!source || offset == null) continue;
    rem[slot] = remainingForClock(source, offset, sourceClock, wallTimeSec);
  }
  return rem;
}

function pickSlotWithMaterial(
  prefer: IntercutSlot,
  slots: IntercutSlot[],
  rem: Record<IntercutSlot, number>,
  maySteal: boolean,
): IntercutSlot | null {
  if (rem[prefer] > 1e-9) return prefer;
  if (!maySteal) return null;
  const start = slots.indexOf(prefer);
  for (let i = 1; i < slots.length; i++) {
    const slot = slots[(start + i) % slots.length]!;
    if (rem[slot] > 1e-9) return slot;
  }
  return null;
}

function entireMaterialBudget(
  slots: IntercutSlot[],
  sources: SlotSources,
  sourceClock: IntercutSourceClock,
): number {
  const avails = slots.map((slot) => sourceAvailableSec(sources[slot]!));
  return sourceClock === 'parallel' ? Math.max(0, ...avails) : avails.reduce((s, v) => s + v, 0);
}

/**
 * Build alternating A/B (or A/B/C) slices for concat demuxer `inpoint` / `outpoint`.
 *
 * `sourceClock` controls whether offscreen clips freeze (`freezeHidden`) or
 * all playheads track output wall time (`parallel`).
 */
export function buildIntercutSlices(config: BuildIntercutSlicesConfig): IntercutSlice[] {
  const {
    sourceA,
    sourceB,
    sourceC,
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

  const slots: IntercutSlot[] = sourceC ? ['A', 'B', 'C'] : ['A', 'B'];
  const sources: SlotSources = { A: sourceA, B: sourceB };
  if (sourceC) sources.C = sourceC;

  const entireBudget = entireMaterialBudget(slots, sources, sourceClock);

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
  let rotation = startWithA ? 0 : 1 % slots.length;
  let offsets: SlotOffsets = {};
  for (const slot of slots) {
    offsets[slot] = sources[slot]!.trimStart;
  }

  while (outputTime < swapBudgetSec - 1e-9) {
    const rem = remainingBySlot(slots, sources, offsets, sourceClock, outputTime);

    if (consumeMode === 'entireSources' && slots.every((s) => rem[s] <= 1e-9)) {
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

    let prefer: IntercutSlot = slots[rotation]!;
    const remainingSwap = swapBudgetSec - outputTime;
    const isLastIntercutSlice =
      consumeMode === 'targetDuration' && remainingSwap - sliceDuration <= 1e-9;

    if (isLastIntercutSlice && forceFinalClip !== 'auto') {
      if (!slots.includes(forceFinalClip)) {
        // Forced C with only A/B sources — fall back to B (previous default landing).
        prefer = slots[slots.length - 1]!;
      } else {
        prefer = forceFinalClip;
      }
    }

    const maySteal =
      sourceClock === 'parallel' ||
      consumeMode === 'entireSources' ||
      (isLastIntercutSlice && forceFinalClip !== 'auto');

    const slot = pickSlotWithMaterial(prefer, slots, rem, maySteal);
    if (!slot) break;

    let taken = takeSlice(slot, sliceDuration, offsets, sources, slots, sourceClock);
    if (!taken && isLastIntercutSlice && forceFinalClip !== 'auto') {
      for (const fallback of slots) {
        if (fallback === slot) continue;
        taken = takeSlice(fallback, sliceDuration, offsets, sources, slots, sourceClock);
        if (taken) break;
      }
    }
    if (!taken) break;

    slices.push(taken.slice);
    offsets = taken.offsets;
    outputTime += taken.actual;
    rotation = (rotation + 1) % slots.length;
  }

  const landing: IntercutSlot =
    forceFinalClip !== 'auto' && slots.includes(forceFinalClip)
      ? forceFinalClip
      : slices.length > 0
        ? slices[slices.length - 1]!.slot
        : startWithA
          ? 'A'
          : slots[1] ?? 'B';

  if (tailDurationSec > 1e-9) {
    const landingSource = sources[landing];
    const landingOffset = offsets[landing];
    const rem =
      landingSource && landingOffset != null
        ? remainingForClock(landingSource, landingOffset, sourceClock, outputTime)
        : 0;
    const tail = Math.min(tailDurationSec, rem);
    if (tail > 1e-9) {
      const last = slices[slices.length - 1];
      if (last && last.slot === landing && sourceClock === 'freezeHidden') {
        last.outpoint += tail;
        offsets[landing] = (offsets[landing] ?? 0) + tail;
      } else if (last && last.slot === landing && sourceClock === 'parallel') {
        last.outpoint += tail;
        for (const s of slots) {
          const src = sources[s];
          const off = offsets[s];
          if (!src || off == null) continue;
          offsets[s] = Math.min(off + tail, src.trimEnd);
        }
      } else {
        const taken = takeSlice(landing, tail, offsets, sources, slots, sourceClock);
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
  fileC?: string,
): string {
  const files: Record<IntercutSlot, string | undefined> = {
    A: fileA,
    B: fileB,
    C: fileC,
  };
  const lines: string[] = [];
  for (const slice of slices) {
    const file = files[slice.slot];
    if (!file) {
      throw new Error(`Intercut playlist is missing a file for clip ${slice.slot}.`);
    }
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
  trimStartC = 0,
): IntercutSlice[] {
  return slices.map((slice) => {
    const base =
      slice.slot === 'A' ? trimStartA : slice.slot === 'C' ? trimStartC : trimStartB;
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
    sourceC?: IntercutSourceBounds;
  },
): number {
  const consumeMode = options?.consumeMode ?? 'targetDuration';
  const sourceClock = options?.sourceClock ?? 'freezeHidden';
  if (consumeMode === 'entireSources' && options?.sourceA && options?.sourceB) {
    const sources: SlotSources = { A: options.sourceA, B: options.sourceB };
    const slots: IntercutSlot[] = ['A', 'B'];
    if (options.sourceC) {
      sources.C = options.sourceC;
      slots.push('C');
    }
    return entireMaterialBudget(slots, sources, sourceClock) + Math.max(0, tailDurationSec);
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
  sourceC?: IntercutSourceBounds,
): string | null {
  const sources: SlotSources = { A: sourceA, B: sourceB };
  const slots: IntercutSlot[] = ['A', 'B'];
  if (sourceC) {
    sources.C = sourceC;
    slots.push('C');
  }
  const usedBySlot = (slot: IntercutSlot) =>
    slices
      .filter((s) => s.slot === slot)
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);

  if (consumeMode === 'entireSources') {
    if (slices.length === 0) {
      const avail = slots.reduce((sum, slot) => sum + sourceAvailableSec(sources[slot]!), 0);
      if (avail <= 1e-9) {
        return slots.length > 2
          ? 'All clips have zero trimmed duration — nothing to intercut.'
          : 'Both clips have zero trimmed duration — nothing to intercut.';
      }
      return 'Intercut produced zero slices — check clip durations and automation settings.';
    }
    const actual = intercutOutputDuration(slices);
    const budget = entireMaterialBudget(slots, sources, sourceClock);
    if (actual >= budget - 1e-3) return null;
    if (sourceClock === 'parallel') {
      return (
        `Could not cover full dual-clock span (${actual.toFixed(2)}s of ` +
        `${budget.toFixed(2)}s). Check frequency / min slice settings.`
      );
    }
    const used = slots.reduce((sum, slot) => sum + usedBySlot(slot), 0);
    const avail = slots.reduce((sum, slot) => sum + sourceAvailableSec(sources[slot]!), 0);
    return (
      `Could not place all source material (${used.toFixed(2)}s of ` +
      `${avail.toFixed(2)}s used). Check frequency / min slice settings.`
    );
  }

  if (requestedSec <= 0) return 'Intercut duration must be greater than zero.';
  const actual = intercutOutputDuration(slices);
  if (slices.length === 0) {
    return 'Intercut produced zero slices — check clip durations and automation settings.';
  }
  if (actual >= requestedSec - 1e-3) return null;

  let exhausted: IntercutSlot = 'A';
  let minRemain = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const avail = sourceAvailableSec(sources[slot]!);
    const remain = avail - usedBySlot(slot);
    if (remain < minRemain) {
      minRemain = remain;
      exhausted = slot;
    }
  }

  return (
    `Requested ${requestedSec.toFixed(2)}s intercut but sources only cover ${actual.toFixed(2)}s ` +
    `(clip ${exhausted} ran out of trimmed material). Shorten the duration or use longer clips.`
  );
}
