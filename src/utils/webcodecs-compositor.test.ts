import { describe, it, expect } from 'vitest';
import { calculateLetterboxRect, computeFadeAlpha } from './webcodecs-compositor';

describe('calculateLetterboxRect', () => {
  it('letterboxes a 16:9 source into a square canvas', () => {
    const rect = calculateLetterboxRect(1920, 1080, 1080, 1080);
    expect(rect.width).toBe(1080);
    expect(rect.height).toBeCloseTo(1080 * (1080 / 1920));
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo((1080 - rect.height) / 2);
  });

  it('pillarboxes a 4:3 source into 16:9', () => {
    const rect = calculateLetterboxRect(640, 480, 1920, 1080);
    expect(rect.height).toBe(1080);
    expect(rect.width).toBeCloseTo(1080 * (640 / 480));
    expect(rect.y).toBe(0);
  });
});

describe('computeFadeAlpha', () => {
  it('ramps in and out around the clip edges', () => {
    expect(computeFadeAlpha(0, 10, 2, 2)).toBe(0);
    expect(computeFadeAlpha(1, 10, 2, 2)).toBe(0.5);
    expect(computeFadeAlpha(5, 10, 2, 2)).toBe(1);
    expect(computeFadeAlpha(9, 10, 2, 2)).toBe(0.5);
    expect(computeFadeAlpha(10, 10, 2, 2)).toBe(0);
  });

  it('stays fully opaque when fades are zero', () => {
    expect(computeFadeAlpha(0, 5, 0, 0)).toBe(1);
    expect(computeFadeAlpha(5, 5, 0, 0)).toBe(1);
  });
});
