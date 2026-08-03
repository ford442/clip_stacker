import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FINISHING,
  colorGradeToLutPass,
  getColorGradeFromFinishing,
  isFinishingActive,
  isLutFinishingPassActive,
  normalizeFinishingSettings,
  resolveFinishingFromProject,
  withColorGrade,
} from './finishing';
import { COLOR_LUT_NONE } from './lut';

describe('finishing settings', () => {
  it('defaults to all passes disabled', () => {
    expect(isFinishingActive(DEFAULT_FINISHING)).toBe(false);
    expect(isLutFinishingPassActive(DEFAULT_FINISHING.lut)).toBe(false);
  });

  it('detects active LUT pass', () => {
    const settings = withColorGrade(DEFAULT_FINISHING, {
      lutId: 'film',
      intensity: 0.5,
    });
    expect(isFinishingActive(settings)).toBe(true);
    expect(isLutFinishingPassActive(settings.lut)).toBe(true);
    expect(getColorGradeFromFinishing(settings)).toEqual({
      lutId: 'film',
      intensity: 0.5,
    });
  });

  it('detects enabled stub passes with amount', () => {
    const settings = {
      ...DEFAULT_FINISHING,
      sharpen: { enabled: true, amount: 0.4 },
    };
    expect(isFinishingActive(settings)).toBe(true);
  });

  it('normalizes partial settings with safe defaults', () => {
    const normalized = normalizeFinishingSettings({
      lut: { enabled: true, lutId: 'warm', intensity: 1.5 },
    });
    expect(normalized.lut?.lutId).toBe('warm');
    expect(normalized.lut?.intensity).toBe(1);
    expect(normalized.noiseReduction?.enabled).toBe(false);
  });

  it('migrates legacy colorGrade when finishing is absent', () => {
    const resolved = resolveFinishingFromProject({
      colorGrade: { lutId: 'bleach', intensity: 0.8 },
    });
    expect(resolved.lut?.enabled).toBe(true);
    expect(resolved.lut?.lutId).toBe('bleach');
    expect(resolved.lut?.intensity).toBe(0.8);
  });

  it('prefers finishing.lut over legacy colorGrade', () => {
    const resolved = resolveFinishingFromProject({
      finishing: {
        lut: { enabled: true, lutId: 'film', intensity: 0.3 },
      },
      colorGrade: { lutId: 'warm', intensity: 1 },
    });
    expect(resolved.lut?.lutId).toBe('film');
  });

  it('maps colorGradeToLutPass with none lut as disabled', () => {
    const pass = colorGradeToLutPass({ lutId: COLOR_LUT_NONE, intensity: 1 });
    expect(pass.enabled).toBe(false);
  });
});
