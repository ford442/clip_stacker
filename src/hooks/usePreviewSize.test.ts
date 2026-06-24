import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computePreviewSize,
  PREVIEW_SIZE_THRESHOLD_PX,
} from './usePreviewSize';

describe('computePreviewSize', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      innerWidth: 1000,
      innerHeight: 800,
      devicePixelRatio: 1,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fits 16:9 inside viewport width cap', () => {
    const size = computePreviewSize(1000, 800, 16 / 9, {
      maxWidthPct: 0.9,
      maxHeightPct: 0.75,
    });
    expect(size.cssWidth).toBe(900);
    expect(size.cssHeight).toBeCloseTo(900 / (16 / 9));
    expect(size.canvasWidth).toBe(Math.round(size.cssWidth));
    expect(size.canvasHeight).toBe(Math.round(size.cssHeight));
  });

  it('limits height by viewport height cap', () => {
    const size = computePreviewSize(2000, 2000, 9 / 16, {
      maxWidthPct: 0.9,
      maxHeightPct: 0.75,
    });
    expect(size.cssHeight).toBe(600);
    expect(size.cssWidth).toBeCloseTo(600 * (9 / 16));
  });

  it('caps backing-store pixel area', () => {
    vi.stubGlobal('window', {
      innerWidth: 3840,
      innerHeight: 2160,
      devicePixelRatio: 2,
    });
    const size = computePreviewSize(3840, 2160, 16 / 9, {
      maxWidthPct: 1,
      maxHeightPct: 1,
      maxPixelArea: 1920 * 1080,
    });
    expect(size.canvasWidth * size.canvasHeight).toBeLessThanOrEqual(1920 * 1080);
  });

  it('uses container width when narrower than viewport cap', () => {
    const size = computePreviewSize(400, 800, 16 / 9, {
      maxWidthPct: 0.9,
      maxHeightPct: 0.75,
    });
    expect(size.cssWidth).toBe(400);
    expect(size.cssHeight).toBeCloseTo(400 / (16 / 9));
  });
});

describe('PREVIEW_SIZE_THRESHOLD_PX', () => {
  it('is a small positive integer for resize debouncing', () => {
    expect(PREVIEW_SIZE_THRESHOLD_PX).toBeGreaterThanOrEqual(1);
    expect(PREVIEW_SIZE_THRESHOLD_PX).toBeLessThanOrEqual(8);
  });
});
