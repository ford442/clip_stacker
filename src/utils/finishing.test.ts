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

  it('detects active secondary color with a selective grade', () => {
    const settings = {
      ...DEFAULT_FINISHING,
      secondaryColor: {
        enabled: true,
        amount: 1,
        grades: [
          {
            enabled: true,
            maskType: 'hue' as const,
            hueCenter: 210,
            hueWidth: 60,
            hueSoftness: 12,
            windowCenterX: 0.5,
            windowCenterY: 0.5,
            windowWidth: 0.5,
            windowHeight: 0.5,
            windowRotation: 0,
            windowFeather: 0.15,
            hueShift: 0,
            satScale: 0.7,
            lumOffset: 0,
            satOffset: 0,
          },
        ],
      },
    };
    expect(isFinishingActive(settings)).toBe(true);
  });

  it('normalizes unknown secondary mask types to hue', () => {
    const normalized = normalizeFinishingSettings({
      secondaryColor: {
        enabled: true,
        grades: [
          {
            enabled: true,
            maskType: 'bitmap',
            satScale: 0.5,
          } as never,
        ],
      },
    });
    expect(normalized.secondaryColor?.grades[0].maskType).toBe('hue');
  });

  it('detects enabled stub passes with amount', () => {
    const settings = {
      ...DEFAULT_FINISHING,
      grain: { enabled: true, amount: 0.4 },
    };
    expect(isFinishingActive(settings)).toBe(true);
  });

  it('detects active sharpen with radius/threshold', () => {
    const settings = {
      ...DEFAULT_FINISHING,
      sharpen: {
        ...DEFAULT_FINISHING.sharpen!,
        enabled: true,
        amount: 0.2,
        radius: 1.5,
        threshold: 0.03,
      },
    };
    expect(isFinishingActive(settings)).toBe(true);
  });

  it('detects active primary color correction', () => {
    const settings = {
      ...DEFAULT_FINISHING,
      primaryColor: {
        ...DEFAULT_FINISHING.primaryColor!,
        enabled: true,
        exposure: -0.5,
        temperature: 0.25,
      },
    };
    expect(isFinishingActive(settings)).toBe(true);
  });

  it('detects active noise reduction', () => {
    const settings = {
      ...DEFAULT_FINISHING,
      noiseReduction: {
        ...DEFAULT_FINISHING.noiseReduction!,
        enabled: true,
        spatialStrength: 0.5,
      },
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
