import { describe, it, expect } from 'vitest';
import { ffmpegColorToCss } from './color';

describe('ffmpegColorToCss', () => {
  it('passes through named and #hex colors with full alpha', () => {
    expect(ffmpegColorToCss('white')).toEqual({ color: 'white', alpha: 1 });
    expect(ffmpegColorToCss('#ff8800')).toEqual({ color: '#ff8800', alpha: 1 });
  });

  it('rewrites 0x-prefixed colors to CSS hex', () => {
    expect(ffmpegColorToCss('0xff8800')).toEqual({
      color: '#ff8800',
      alpha: 1,
    });
  });

  it('parses a float @alpha suffix', () => {
    expect(ffmpegColorToCss('black@0.5')).toEqual({
      color: 'black',
      alpha: 0.5,
    });
  });

  it('parses a hex-byte @alpha suffix', () => {
    expect(ffmpegColorToCss('0x000000@0x80').alpha).toBeCloseTo(128 / 255);
    expect(ffmpegColorToCss('red@ff').alpha).toBe(1);
  });

  it('clamps alpha into [0,1]', () => {
    expect(ffmpegColorToCss('white@2').alpha).toBeLessThanOrEqual(1);
    expect(ffmpegColorToCss('white@-1').alpha).toBeGreaterThanOrEqual(0);
  });
});
