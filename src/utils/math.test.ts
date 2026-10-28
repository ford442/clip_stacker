import { describe, expect, it } from 'vitest';
import { clamp, clamp01, clamp01Finite, finiteOr } from './math';

describe('clamp', () => {
  it('passes values inside the range through', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-3, -3, 3)).toBe(-3);
    expect(clamp(3, -3, 3)).toBe(3);
  });

  it('pins values outside the range to the nearest bound', () => {
    expect(clamp(-1, 0, 2)).toBe(0);
    expect(clamp(5, 0, 2)).toBe(2);
    expect(clamp(Infinity, 0.5, 32)).toBe(32);
    expect(clamp(-Infinity, 0.5, 32)).toBe(0.5);
  });

  it('keeps NaN as NaN', () => {
    expect(clamp(Number.NaN, 0, 1)).toBeNaN();
  });

  it('lets max win when the bounds are inverted', () => {
    expect(clamp(4, 5, 3)).toBe(3);
    expect(clamp(0, 5, 3)).toBe(3);
  });

  it('normalizes -0 to +0 at a zero lower bound', () => {
    expect(Object.is(clamp(-0, 0, 1), 0)).toBe(true);
  });
});

describe('clamp01', () => {
  it('clamps into [0, 1]', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1.7)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
  });

  it('keeps NaN as NaN', () => {
    expect(clamp01(Number.NaN)).toBeNaN();
  });
});

describe('clamp01Finite', () => {
  it('clamps finite values into [0, 1]', () => {
    expect(clamp01Finite(-0.2)).toBe(0);
    expect(clamp01Finite(0.4)).toBe(0.4);
    expect(clamp01Finite(2)).toBe(1);
  });

  it('returns 0 for non-finite input by default', () => {
    expect(clamp01Finite(Number.NaN)).toBe(0);
    expect(clamp01Finite(Infinity)).toBe(0);
    expect(clamp01Finite(-Infinity)).toBe(0);
  });

  it('returns the given fallback for non-finite input', () => {
    expect(clamp01Finite(Number.NaN, 0.3)).toBe(0.3);
    expect(clamp01Finite(Infinity, 0.3)).toBe(0.3);
    expect(clamp01Finite(0.9, 0.3)).toBe(0.9);
  });
});

describe('finiteOr', () => {
  it('returns finite numbers unchanged', () => {
    expect(finiteOr(0, 5)).toBe(0);
    expect(finiteOr(-2.5, 5)).toBe(-2.5);
  });

  it('falls back for non-numbers and non-finite numbers', () => {
    for (const value of [undefined, null, '3', Number.NaN, Infinity, {}]) {
      expect(finiteOr(value, 5)).toBe(5);
    }
  });
});
