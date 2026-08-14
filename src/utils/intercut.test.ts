import { describe, expect, it } from 'vitest';
import { EASING_PRESETS } from './keyframes';
import {
  buildConcatPlaylist,
  buildIntercutSlices,
  canUseStreamCopyForIntercut,
  frequencyHzAtTime,
  hzToSecondsPerCut,
  intercutOutputDuration,
  intercutShortageMessage,
  remapIntercutSlicesToTrimOrigin,
  INTERCUT_MIN_STREAM_COPY_SLICE_SEC,
  secondsPerCutToHz,
} from './intercut';

describe('intercut', () => {
  it('advances source offsets independently per clip', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.6,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });

    expect(slices.length).toBeGreaterThanOrEqual(3);
    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 0, outpoint: 0.2 });
    expect(slices[1]).toMatchObject({ slot: 'B', inpoint: 0, outpoint: 0.2 });
    expect(slices[2]).toMatchObject({ slot: 'A', inpoint: 0.2 });
    expect(slices[2]!.outpoint).toBeCloseTo(0.4, 5);
  });

  it('does not use output timeline as source inpoint', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 1, trimEnd: 5 },
      sourceB: { trimStart: 2, trimEnd: 6 },
      automation: {
        totalDurationSec: 0.4,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });

    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 1, outpoint: 1.2 });
    expect(slices[1]).toMatchObject({ slot: 'B', inpoint: 2, outpoint: 2.2 });
  });

  it('stops when a source is exhausted', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 0.15 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 5,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });

    const aDuration = slices
      .filter((s) => s.slot === 'A')
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
    expect(aDuration).toBeCloseTo(0.15, 3);
    expect(intercutOutputDuration(slices)).toBeLessThan(5);
  });

  it('accelerates slice frequency with ease-in ramp', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 30 },
      sourceB: { trimStart: 0, trimEnd: 30 },
      automation: {
        totalDurationSec: 5,
        startFrequencyHz: 0.5,
        endFrequencyHz: 8,
        easing: EASING_PRESETS.easeIn,
      },
    });

    const firstDur = slices[0]!.outpoint - slices[0]!.inpoint;
    const lastDur = slices[slices.length - 1]!.outpoint - slices[slices.length - 1]!.inpoint;
    expect(firstDur).toBeGreaterThan(lastDur);
    expect(slices.length).toBeGreaterThan(10);
  });

  it('frequencyHzAtTime honors explicit frequency keyframes', () => {
    const hz = frequencyHzAtTime(
      {
        totalDurationSec: 4,
        startFrequencyHz: 1,
        endFrequencyHz: 1,
        frequencyKeyframes: [
          { t: 0, value: 2 },
          { t: 2, value: 10 },
        ],
      },
      1,
    );
    expect(hz).toBeCloseTo(6, 1);
  });

  it('buildConcatPlaylist emits concat demuxer inpoint/outpoint lines', () => {
    const playlist = buildConcatPlaylist(
      [{ slot: 'A', inpoint: 0, outpoint: 0.25 }],
      'clip_a.mp4',
      'clip_b.mp4',
    );
    expect(playlist).toContain("file 'clip_a.mp4'");
    expect(playlist).toContain('inpoint 0.000000');
    expect(playlist).toContain('outpoint 0.250000');
  });

  it('canUseStreamCopyForIntercut rejects short strobe slices', () => {
    expect(
      canUseStreamCopyForIntercut([
        { slot: 'A', inpoint: 0, outpoint: INTERCUT_MIN_STREAM_COPY_SLICE_SEC - 0.1 },
      ]),
    ).toBe(false);
    expect(
      canUseStreamCopyForIntercut([
        { slot: 'A', inpoint: 0, outpoint: INTERCUT_MIN_STREAM_COPY_SLICE_SEC },
      ]),
    ).toBe(true);
  });

  it('remapIntercutSlicesToTrimOrigin shifts A/B inpoints independently', () => {
    const remapped = remapIntercutSlicesToTrimOrigin(
      [
        { slot: 'A', inpoint: 2, outpoint: 2.5 },
        { slot: 'B', inpoint: 5, outpoint: 5.2 },
      ],
      2,
      4,
    );
    expect(remapped).toHaveLength(2);
    expect(remapped[0]).toMatchObject({ slot: 'A', inpoint: 0, outpoint: 0.5 });
    expect(remapped[1]!.slot).toBe('B');
    expect(remapped[1]!.inpoint).toBeCloseTo(1, 5);
    expect(remapped[1]!.outpoint).toBeCloseTo(1.2, 5);
  });

  it('snaps slice duration to beat stride when slower than the beat grid', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 20 },
      sourceB: { trimStart: 0, trimEnd: 20 },
      automation: {
        totalDurationSec: 2,
        startFrequencyHz: 2,
        endFrequencyHz: 2,
      },
      beatSync: {
        beatTimestamps: [0, 0.5, 1, 1.5, 2, 2.5, 3],
        stride: 2,
      },
    });

    expect(slices[0]!.outpoint - slices[0]!.inpoint).toBeCloseTo(1, 5);
    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 0 });
    expect(slices[1]).toMatchObject({ slot: 'B', inpoint: 0 });
  });

  it('falls back to Hz when requested strobe is faster than every beat', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.4,
        startFrequencyHz: 10,
        endFrequencyHz: 10,
      },
      beatSync: {
        beatTimestamps: [0, 0.5, 1, 1.5],
      },
    });

    expect(slices[0]!.outpoint - slices[0]!.inpoint).toBeCloseTo(0.1, 5);
  });

  it('reports a shortage when sources cannot cover the requested duration', () => {
    const sourceA = { trimStart: 0, trimEnd: 0.2 };
    const sourceB = { trimStart: 0, trimEnd: 10 };
    const slices = buildIntercutSlices({
      sourceA,
      sourceB,
      automation: {
        totalDurationSec: 5,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });
    const msg = intercutShortageMessage(slices, 5, sourceA, sourceB);
    expect(msg).toMatch(/only cover/i);
    expect(msg).toMatch(/clip A/i);
  });

  it('converts Hz and seconds-per-cut', () => {
    expect(hzToSecondsPerCut(0.5)).toBeCloseTo(2, 5);
    expect(secondsPerCutToHz(2)).toBeCloseTo(0.5, 5);
  });

  it('lands on clip B when forceFinalClip is B even if the last turn would be A', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.6,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      forceFinalClip: 'B',
    });

    // 0.2s slices → 3 slices; without force the last would be A.
    expect(slices).toHaveLength(3);
    expect(slices[0]!.slot).toBe('A');
    expect(slices[1]!.slot).toBe('B');
    expect(slices[2]!.slot).toBe('B');
    expect(slices[2]!.inpoint).toBeCloseTo(0.2, 5);
    expect(slices[2]!.outpoint).toBeCloseTo(0.4, 5);
    expect(slices[1]).toMatchObject({ inpoint: 0, outpoint: 0.2 });
  });

  it('extends the last slice when tail stays on the same landing clip', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.4,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      forceFinalClip: 'B',
      tailDurationSec: 2,
    });

    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 0, outpoint: 0.2 });
    expect(slices[1]).toMatchObject({ slot: 'B', inpoint: 0, outpoint: 2.2 });
    expect(intercutOutputDuration(slices)).toBeCloseTo(2.4, 5);
  });

  it('extends clip A when auto landing plus tail follows an A-ending swap', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.2,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      forceFinalClip: 'auto',
      tailDurationSec: 1,
    });

    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 0, outpoint: 1.2 });
  });

  it('appends a landing-clip tail when there is no swapping phase', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 1, trimEnd: 6 },
      automation: {
        totalDurationSec: 0,
        startFrequencyHz: 1,
        endFrequencyHz: 1,
      },
      forceFinalClip: 'B',
      tailDurationSec: 2,
    });

    expect(slices).toEqual([{ slot: 'B', inpoint: 1, outpoint: 3 }]);
  });

  it('clamps tail to remaining landing-clip material', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 0.5 },
      automation: {
        totalDurationSec: 0.4,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      forceFinalClip: 'B',
      tailDurationSec: 4,
    });

    expect(slices[slices.length - 1]).toMatchObject({ slot: 'B', inpoint: 0, outpoint: 0.5 });
    expect(intercutOutputDuration(slices)).toBeCloseTo(0.7, 5);
  });
});
