import { describe, it, expect } from 'vitest';
import {
  applyEasing,
  cubicBezier,
  sampleKeyframes,
  sortKeyframes,
  upsertKeyframe,
  type Keyframe,
} from './keyframes';

describe('keyframes', () => {
  const track: Keyframe[] = [
    { t: 0, value: 0, easing: { type: 'linear' } },
    { t: 1, value: 100, easing: { type: 'linear' } },
  ];

  it('returns default when track is empty', () => {
    expect(sampleKeyframes(undefined, 0.5, 42)).toBe(42);
  });

  it('interpolates linearly between keys', () => {
    expect(sampleKeyframes(track, 0, 0)).toBe(0);
    expect(sampleKeyframes(track, 0.5, 0)).toBe(50);
    expect(sampleKeyframes(track, 1, 0)).toBe(100);
    expect(sampleKeyframes(track, 2, 0)).toBe(100);
  });

  it('holds before first and after last key', () => {
    const k: Keyframe[] = [
      { t: 1, value: 10 },
      { t: 3, value: 30 },
    ];
    expect(sampleKeyframes(k, 0, 0)).toBe(10);
    expect(sampleKeyframes(k, 5, 0)).toBe(30);
  });

  it('applies cubic-bezier easing between keys', () => {
    const eased: Keyframe[] = [
      { t: 0, value: 0, easing: { type: 'bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 } },
      { t: 1, value: 100 },
    ];
    const mid = sampleKeyframes(eased, 0.5, 0);
    expect(mid).toBeGreaterThan(50);
    expect(mid).toBeLessThan(100);
  });

  it('cubicBezier endpoints are 0 and 1', () => {
    expect(cubicBezier(0, 0.42, 0, 0.58, 1)).toBeCloseTo(0, 5);
    expect(cubicBezier(1, 0.42, 0, 0.58, 1)).toBeCloseTo(1, 5);
  });

  it('sorts and upserts keyframes by time', () => {
    const merged = upsertKeyframe([{ t: 0, value: 1 }], 0.5, 2);
    expect(sortKeyframes(merged).map((k) => k.t)).toEqual([0, 0.5]);
    const updated = upsertKeyframe(merged, 0.5, 9);
    expect(sampleKeyframes(updated, 0.5, 0)).toBe(9);
  });

  it('applyEasing linear passthrough', () => {
    expect(applyEasing(0.25, { type: 'linear' })).toBe(0.25);
  });

  it('evaluates bellCurveSmooth half-sine curve', () => {
    expect(applyEasing(0, { type: 'bellCurveSmooth' })).toBeCloseTo(0, 5);
    expect(applyEasing(0.5, { type: 'bellCurveSmooth' })).toBeCloseTo(1, 5);
    expect(applyEasing(1, { type: 'bellCurveSmooth' })).toBeCloseTo(0, 5);
    expect(applyEasing(0.25, { type: 'bellCurveSmooth' })).toBeCloseTo(Math.SQRT1_2, 5);
    expect(applyEasing(0.75, { type: 'bellCurveSmooth' })).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('evaluates bellCurveSharp exponential peak', () => {
    expect(applyEasing(0, { type: 'bellCurveSharp' })).toBeCloseTo(0, 5);
    expect(applyEasing(0.5, { type: 'bellCurveSharp' })).toBeCloseTo(1, 5);
    expect(applyEasing(1, { type: 'bellCurveSharp' })).toBeCloseTo(0, 5);
    // At quarter way, fold is 0.5 -> 2^(5-10) = 2^-5 = 0.03125
    expect(applyEasing(0.25, { type: 'bellCurveSharp' })).toBeCloseTo(0.03125, 4);
    expect(applyEasing(0.75, { type: 'bellCurveSharp' })).toBeCloseTo(0.03125, 4);
  });

  it('samples keyframes with bellCurveSmooth easing', () => {
    const bellTrack: Keyframe[] = [
      { t: 0, value: 0.5, easing: { type: 'bellCurveSmooth' } },
      { t: 6, value: 12.0 },
    ];
    expect(sampleKeyframes(bellTrack, 0, 0.5)).toBeCloseTo(0.5, 4);
    expect(sampleKeyframes(bellTrack, 3, 0.5)).toBeCloseTo(12.0, 4);
    expect(sampleKeyframes(bellTrack, 6, 0.5)).toBeCloseTo(0.5, 4);
  });
});
