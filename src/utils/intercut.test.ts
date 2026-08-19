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

  it('ramps up to peak and decelerates back down with bell-curve easing', () => {
    const automation = {
      totalDurationSec: 6,
      startFrequencyHz: 0.5, // 2s per cut
      endFrequencyHz: 10,   // 0.1s per cut at peak
      easing: EASING_PRESETS.bellCurveSmooth,
    };

    // Frequency starts at base Hz, peaks at midpoint, and decelerates back to base Hz
    expect(frequencyHzAtTime(automation, 0)).toBeCloseTo(0.5, 3);
    expect(frequencyHzAtTime(automation, 3)).toBeCloseTo(10, 3);
    expect(frequencyHzAtTime(automation, 6)).toBeCloseTo(0.5, 3);

    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 30 },
      sourceB: { trimStart: 0, trimEnd: 30 },
      automation,
      forceFinalClip: 'B',
      tailDurationSec: 2,
    });

    const firstDur = slices[0]!.outpoint - slices[0]!.inpoint;
    const lastSlice = slices[slices.length - 1]!;
    const lastDur = lastSlice.outpoint - lastSlice.inpoint;

    // First slice should be slow (start frequency 0.5 Hz -> 2s duration)
    expect(firstDur).toBeCloseTo(2.0, 1);
    // Last slice lands on B and includes the 2s tail duration
    expect(lastSlice.slot).toBe('B');
    expect(lastDur).toBeGreaterThanOrEqual(2.0);

    // Peak strobe slices around midpoint are fast (< 0.2s)
    const minDur = Math.min(...slices.map((s) => s.outpoint - s.inpoint));
    expect(minDur).toBeLessThan(0.2);
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

  it('entireSources mode uses all of A and all of B (output ≈ A + B)', () => {
    const sourceA = { trimStart: 0, trimEnd: 1.0 };
    const sourceB = { trimStart: 0, trimEnd: 0.6 };
    const slices = buildIntercutSlices({
      sourceA,
      sourceB,
      automation: {
        totalDurationSec: 0, // ignored for swap length
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      consumeMode: 'entireSources',
    });

    const usedA = slices
      .filter((s) => s.slot === 'A')
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
    const usedB = slices
      .filter((s) => s.slot === 'B')
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);

    expect(usedA).toBeCloseTo(1.0, 5);
    expect(usedB).toBeCloseTo(0.6, 5);
    expect(intercutOutputDuration(slices)).toBeCloseTo(1.6, 5);

    // Hidden freezes: A resumes where it left off (no parallel wall-clock skip).
    const aSlices = slices.filter((s) => s.slot === 'A');
    for (let i = 1; i < aSlices.length; i++) {
      expect(aSlices[i]!.inpoint).toBeCloseTo(aSlices[i - 1]!.outpoint, 5);
    }
  });

  it('entireSources drains the longer clip after the shorter is empty', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 0.2 },
      sourceB: { trimStart: 0, trimEnd: 1.0 },
      automation: {
        totalDurationSec: 99,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      consumeMode: 'entireSources',
    });

    const usedA = slices
      .filter((s) => s.slot === 'A')
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
    const usedB = slices
      .filter((s) => s.slot === 'B')
      .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
    expect(usedA).toBeCloseTo(0.2, 5);
    expect(usedB).toBeCloseTo(1.0, 5);
  });

  it('parallel clock advances the hidden source with wall time', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.6,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      sourceClock: 'parallel',
    });

    // A 0–0.2, B 0.2–0.4 (not 0–0.2), A 0.4–0.6
    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 0, outpoint: 0.2 });
    expect(slices[1]).toMatchObject({ slot: 'B', inpoint: 0.2, outpoint: 0.4 });
    expect(slices[2]).toMatchObject({ slot: 'A', inpoint: 0.4, outpoint: 0.6 });
  });

  it('parallel entireSources spans max(A, B) wall time', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 0.4 },
      sourceB: { trimStart: 0, trimEnd: 1.0 },
      automation: {
        totalDurationSec: 0,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      consumeMode: 'entireSources',
      sourceClock: 'parallel',
    });

    expect(intercutOutputDuration(slices)).toBeCloseTo(1.0, 5);
    // After A’s wall span ends, remaining wall time is filled from B.
    const last = slices[slices.length - 1]!;
    expect(last.slot).toBe('B');
    expect(last.outpoint).toBeCloseTo(1.0, 5);
  });

  it('cycles A → B → C when a third source is provided', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      sourceC: { trimStart: 1, trimEnd: 11 },
      automation: {
        totalDurationSec: 0.6,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
    });

    expect(slices).toHaveLength(3);
    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 0, outpoint: 0.2 });
    expect(slices[1]).toMatchObject({ slot: 'B', inpoint: 0, outpoint: 0.2 });
    expect(slices[2]).toMatchObject({ slot: 'C', inpoint: 1, outpoint: 1.2 });
  });

  it('three-clip parallel clock advances hidden sources with wall time', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      sourceC: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.6,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      sourceClock: 'parallel',
    });

    expect(slices[0]).toMatchObject({ slot: 'A', inpoint: 0, outpoint: 0.2 });
    expect(slices[1]).toMatchObject({ slot: 'B', inpoint: 0.2, outpoint: 0.4 });
    expect(slices[2]).toMatchObject({ slot: 'C', inpoint: 0.4, outpoint: 0.6 });
  });

  it('three-clip entireSources uses A+B+C in freezeHidden', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 0.4 },
      sourceB: { trimStart: 0, trimEnd: 0.4 },
      sourceC: { trimStart: 0, trimEnd: 0.2 },
      automation: {
        totalDurationSec: 0,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      consumeMode: 'entireSources',
    });

    const used = (slot: 'A' | 'B' | 'C') =>
      slices
        .filter((s) => s.slot === slot)
        .reduce((sum, s) => sum + (s.outpoint - s.inpoint), 0);
    expect(used('A')).toBeCloseTo(0.4, 5);
    expect(used('B')).toBeCloseTo(0.4, 5);
    expect(used('C')).toBeCloseTo(0.2, 5);
    expect(intercutOutputDuration(slices)).toBeCloseTo(1.0, 5);
  });

  it('lands on clip C when forceFinalClip is C', () => {
    const slices = buildIntercutSlices({
      sourceA: { trimStart: 0, trimEnd: 10 },
      sourceB: { trimStart: 0, trimEnd: 10 },
      sourceC: { trimStart: 0, trimEnd: 10 },
      automation: {
        totalDurationSec: 0.8,
        startFrequencyHz: 5,
        endFrequencyHz: 5,
      },
      forceFinalClip: 'C',
    });

    // 4 slices of 0.2s; without force the last would be A.
    expect(slices).toHaveLength(4);
    expect(slices.map((s) => s.slot)).toEqual(['A', 'B', 'C', 'C']);
  });

  it('buildConcatPlaylist emits clip C files', () => {
    const playlist = buildConcatPlaylist(
      [{ slot: 'C', inpoint: 1, outpoint: 1.25 }],
      'clip_a.mp4',
      'clip_b.mp4',
      'clip_c.mp4',
    );
    expect(playlist).toContain("file 'clip_c.mp4'");
    expect(playlist).toContain('inpoint 1.000000');
  });

  it('remapIntercutSlicesToTrimOrigin shifts C independently', () => {
    const remapped = remapIntercutSlicesToTrimOrigin(
      [{ slot: 'C', inpoint: 5, outpoint: 5.5 }],
      0,
      0,
      5,
    );
    expect(remapped[0]).toMatchObject({ slot: 'C', inpoint: 0, outpoint: 0.5 });
  });
});
