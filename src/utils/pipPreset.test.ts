import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { buildPipRect, clipAspectRatio, nextOverlayLayerIndex, parseCanvasSize } from './pipPreset';

function makeClip(id: string, layerIndex?: number): Clip {
  return { id, layerIndex } as Clip;
}

describe('parseCanvasSize', () => {
  it('parses WIDTHxHEIGHT', () => {
    expect(parseCanvasSize('1920x1080')).toEqual({ width: 1920, height: 1080 });
  });

  it('falls back to the default canvas for original/invalid values', () => {
    expect(parseCanvasSize('original')).toEqual({ width: 1280, height: 720 });
    expect(parseCanvasSize(undefined)).toEqual({ width: 1280, height: 720 });
    expect(parseCanvasSize('0x0')).toEqual({ width: 1280, height: 720 });
  });
});

describe('nextOverlayLayerIndex', () => {
  it('returns 1 when no overlays exist', () => {
    expect(nextOverlayLayerIndex([makeClip('a'), makeClip('b', 0)])).toBe(1);
  });

  it('skips layers already in use', () => {
    expect(nextOverlayLayerIndex([makeClip('a', 1), makeClip('b', 2)])).toBe(3);
  });

  it('fills gaps in the used layers', () => {
    expect(nextOverlayLayerIndex([makeClip('a', 1), makeClip('b', 3)])).toBe(2);
  });

  it('ignores the clip being promoted', () => {
    expect(nextOverlayLayerIndex([makeClip('a', 1)], 'a')).toBe(1);
  });
});

describe('buildPipRect', () => {
  it('produces a 320x180 bottom-right overlay on a 720p canvas', () => {
    expect(buildPipRect({ width: 1280, height: 720 }, 'bottom-right')).toEqual({
      x: 928,
      y: 508,
      width: 320,
      height: 180,
    });
  });

  it('places top-left at the margin', () => {
    expect(buildPipRect({ width: 1280, height: 720 }, 'top-left')).toMatchObject({ x: 32, y: 32 });
  });

  it('scales with the canvas', () => {
    const rect = buildPipRect({ width: 1920, height: 1080 }, 'top-right');
    expect(rect.width).toBe(480);
    expect(rect.height).toBe(270);
    expect(rect.x).toBe(1920 - 480 - 48);
    expect(rect.y).toBe(48);
  });

  it('honours the clip aspect ratio', () => {
    expect(buildPipRect({ width: 1280, height: 720 }, 'bottom-right', 1)).toMatchObject({
      width: 320,
      height: 320,
    });
  });

  it('keeps the overlay on canvas', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const rect = buildPipRect({ width: 1280, height: 720 }, corner);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1280);
      expect(rect.y + rect.height).toBeLessThanOrEqual(720);
    }
  });
});

describe('clipAspectRatio', () => {
  it('returns the source ratio when known', () => {
    expect(clipAspectRatio({ videoWidth: 1920, videoHeight: 1080 })).toBeCloseTo(16 / 9);
  });

  it('returns undefined when dimensions are missing', () => {
    expect(clipAspectRatio({ videoWidth: 0, videoHeight: 0 })).toBeUndefined();
    expect(clipAspectRatio({})).toBeUndefined();
  });
});
