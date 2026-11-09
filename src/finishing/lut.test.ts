import { describe, it, expect } from 'vitest';
import {
  BUNDLED_LUT_PRESETS,
  COLOR_LUT_NONE,
  createBundledLut,
  isColorGradeActive,
  lutDataToRgba8,
  parseCubeLut,
  resolveLutData,
} from './lut';

describe('lut', () => {
  it('parses a minimal .cube LUT', () => {
    const lines = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'];
    const lut = parseCubeLut(lines.join('\n'));
    expect(lut.size).toBe(2);
    expect(lut.data).toHaveLength(2 * 2 * 2 * 3);
    expect(lut.data[0]).toBe(0);
    expect(lut.data[3]).toBe(1);
  });

  it('creates bundled presets', () => {
    expect(BUNDLED_LUT_PRESETS.length).toBeGreaterThanOrEqual(3);
    for (const preset of BUNDLED_LUT_PRESETS) {
      const lut = createBundledLut(preset.id);
      expect(lut).not.toBeNull();
      expect(lut!.size).toBeGreaterThan(1);
      expect(lut!.data.length).toBe(lut!.size ** 3 * 3);
    }
  });

  it('packs RGBA8 upload buffers', () => {
    const lut = createBundledLut('film')!;
    const rgba = lutDataToRgba8(lut);
    expect(rgba.length).toBe(lut.size ** 3 * 4);
    expect(rgba[3]).toBe(255);
  });

  it('detects active color grade', () => {
    expect(isColorGradeActive({ lutId: COLOR_LUT_NONE, intensity: 1 })).toBe(false);
    expect(isColorGradeActive({ lutId: 'film', intensity: 0 })).toBe(false);
    expect(isColorGradeActive({ lutId: 'film', intensity: 0.5 })).toBe(true);
  });

  it('resolves custom cube text', () => {
    const cube = ['LUT_3D_SIZE 2', ...Array.from({ length: 8 }, (_, i) => `${i / 7} ${i / 7} ${i / 7}`)].join('\n');
    const lut = resolveLutData({
      lutId: 'custom',
      intensity: 1,
      customCubeText: cube,
    });
    expect(lut?.size).toBe(2);
  });
});
