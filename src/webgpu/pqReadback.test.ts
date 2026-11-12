import { describe, expect, it } from 'vitest';
import { halfToFloat, rgba16fRowsToRgba8 } from './pqReadback';

describe('halfToFloat', () => {
  it('decodes normals, subnormals and specials', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0x3800)).toBe(0.5);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x0001)).toBe(2 ** -24);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0x7e00)).toBeNaN();
    expect(halfToFloat(0x0000)).toBe(0);
  });
});

describe('rgba16fRowsToRgba8', () => {
  it('drops row padding and clamps to 8-bit codes', () => {
    // 1x2 image, 16-byte rows (8 halves: 4 used, 4 padding).
    const halves = new Uint16Array([
      0x3c00, 0x3800, 0x0000, 0x4000, 0xffff, 0xffff, 0xffff, 0xffff,
      0x7e00, 0xbc00, 0x3c00, 0x3c00, 0xffff, 0xffff, 0xffff, 0xffff,
    ]);
    expect(Array.from(rgba16fRowsToRgba8(halves, 1, 2, 16))).toEqual([
      255, 128, 0, 255,
      0, 0, 255, 255,
    ]);
  });
});
