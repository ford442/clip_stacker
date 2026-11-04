import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIMARY_COLOR,
  normalizeFinishingSettings,
  isPrimaryColorActive,
  isFinishingActive,
} from './finishing';
import {
  PRIMARY_COLOR_UNIFORM_FLOATS,
  PRIMARY_CONTRAST_PIVOT,
  appendPrimaryColorFilters,
  buildPrimaryColorFfmpegFilters,
  isPrimaryColorNeutral,
  normalizePrimaryColorPass,
  packPrimaryColorUniforms,
} from './primaryColor';

describe('primary color settings', () => {
  it('defaults are neutral and inactive', () => {
    expect(isPrimaryColorNeutral(DEFAULT_PRIMARY_COLOR)).toBe(true);
    expect(isPrimaryColorActive(DEFAULT_PRIMARY_COLOR)).toBe(false);
    expect(isFinishingActive({ primaryColor: DEFAULT_PRIMARY_COLOR })).toBe(false);
  });

  it('detects active primary when enabled with amount', () => {
    const pass = {
      ...DEFAULT_PRIMARY_COLOR,
      enabled: true,
      exposure: 0.5,
    };
    expect(isPrimaryColorActive(pass)).toBe(true);
    expect(isPrimaryColorNeutral(pass)).toBe(false);
  });

  it('normalizes out-of-range values', () => {
    const normalized = normalizePrimaryColorPass(
      {
        enabled: true,
        exposure: 99,
        contrast: -5,
        saturation: 5,
        temperature: 3,
        tint: -4,
        lift: [2, -2, 0.5] as [number, number, number],
        gamma: [0, 10, 1] as [number, number, number],
        gain: [-1, 5, 1] as [number, number, number],
      },
      DEFAULT_PRIMARY_COLOR,
    );
    expect(normalized.exposure).toBe(3);
    expect(normalized.contrast).toBe(0);
    expect(normalized.saturation).toBe(2);
    expect(normalized.temperature).toBe(1);
    expect(normalized.tint).toBe(-1);
    expect(normalized.lift).toEqual([1, -1, 0.5]);
    expect(normalized.gamma[0]).toBe(0.1);
    expect(normalized.gamma[1]).toBe(3);
    expect(normalized.gain[0]).toBe(0);
    expect(normalized.gain[1]).toBe(2);
  });

  it('normalizeFinishingSettings restores primary fields', () => {
    const normalized = normalizeFinishingSettings({
      primaryColor: {
        enabled: true,
        exposure: 1.25,
        contrast: 1.1,
        saturation: 0.9,
        temperature: -0.2,
        tint: 0.1,
        lift: [0.05, 0, -0.02],
        gamma: [1, 1.05, 1],
        gain: [1.1, 1, 0.95],
      },
    });
    expect(normalized.primaryColor?.enabled).toBe(true);
    expect(normalized.primaryColor?.exposure).toBe(1.25);
    expect(normalized.primaryColor?.lift?.[0]).toBeCloseTo(0.05);
    expect(normalized.primaryColor?.gain?.[2]).toBeCloseTo(0.95);
  });
});

describe('packPrimaryColorUniforms', () => {
  it('packs 24 floats with neutral defaults', () => {
    const packed = packPrimaryColorUniforms({
      ...DEFAULT_PRIMARY_COLOR,
      enabled: true,
      amount: 1,
    });
    expect(packed).toHaveLength(PRIMARY_COLOR_UNIFORM_FLOATS);
    expect(packed[0]).toBe(1); // amount
    expect(packed[1]).toBe(0); // exposure
    expect(packed[2]).toBe(1); // contrast
    expect(packed[3]).toBe(1); // saturation
    expect(packed[4]).toBe(0); // temperature
    expect(packed[5]).toBe(0); // tint
    expect(packed[6]).toBeCloseTo(PRIMARY_CONTRAST_PIVOT);
    expect(Array.from(packed.slice(8, 11))).toEqual([0, 0, 0]); // lift
    expect(Array.from(packed.slice(12, 15))).toEqual([1, 1, 1]); // gamma
    expect(Array.from(packed.slice(16, 19))).toEqual([1, 1, 1]); // gain
  });

  it('writes correction params into expected slots', () => {
    const packed = packPrimaryColorUniforms({
      enabled: true,
      amount: 0.75,
      exposure: -1.5,
      contrast: 1.25,
      saturation: 0.5,
      temperature: 0.4,
      tint: -0.3,
      lift: [0.1, -0.05, 0],
      gamma: [0.9, 1, 1.1],
      gain: [1.2, 1, 0.8],
    });
    expect(packed[0]).toBeCloseTo(0.75);
    expect(packed[1]).toBeCloseTo(-1.5);
    expect(packed[2]).toBeCloseTo(1.25);
    expect(packed[3]).toBeCloseTo(0.5);
    expect(packed[4]).toBeCloseTo(0.4);
    expect(packed[5]).toBeCloseTo(-0.3);
    expect(packed[8]).toBeCloseTo(0.1);
    expect(packed[9]).toBeCloseTo(-0.05);
    expect(packed[12]).toBeCloseTo(0.9);
    expect(packed[14]).toBeCloseTo(1.1);
    expect(packed[16]).toBeCloseTo(1.2);
    expect(packed[18]).toBeCloseTo(0.8);
  });

  it('zeros amount when disabled', () => {
    const packed = packPrimaryColorUniforms({
      ...DEFAULT_PRIMARY_COLOR,
      enabled: false,
      amount: 1,
      exposure: 2,
    });
    expect(packed[0]).toBe(0);
  });
});

describe('buildPrimaryColorFfmpegFilters', () => {
  it('returns empty string for disabled or neutral', () => {
    expect(buildPrimaryColorFfmpegFilters(undefined)).toBe('');
    expect(buildPrimaryColorFfmpegFilters(DEFAULT_PRIMARY_COLOR)).toBe('');
    expect(
      buildPrimaryColorFfmpegFilters({
        ...DEFAULT_PRIMARY_COLOR,
        enabled: true,
      }),
    ).toBe('');
  });

  it('builds eq + colortemperature + colorbalance golden strings', () => {
    const filters = buildPrimaryColorFfmpegFilters({
      enabled: true,
      amount: 1,
      exposure: 1.2,
      contrast: 1.15,
      saturation: 0.8,
      temperature: 0.4,
      tint: -0.2,
      lift: [0.05, 0, -0.03],
      gamma: [1.05, 1, 0.95],
      gain: [1.1, 1, 0.9],
    });
    expect(filters).toContain('eq=brightness=0.2:contrast=1.15:saturation=0.8:gamma=1');
    expect(filters).toContain('colortemperature=temperature=5500:mix=1');
    expect(filters).toContain('colorbalance=');
    expect(filters).toContain('rs=0.05');
    expect(filters).toContain('bs=-0.03');
  });

  it('scales corrections by amount', () => {
    const filters = buildPrimaryColorFfmpegFilters({
      enabled: true,
      amount: 0.5,
      exposure: 1.2,
      contrast: 1,
      saturation: 1,
      temperature: 0,
      tint: 0,
      lift: [0, 0, 0],
      gamma: [1, 1, 1],
      gain: [1, 1, 1],
    });
    // brightness = (1.2 * 0.5) / 6 = 0.1
    expect(filters).toBe('eq=brightness=0.1:contrast=1:saturation=1:gamma=1');
  });

  it('appendPrimaryColorFilters rewrites [vout] sink', () => {
    const base = '[0:v]null[vout]';
    const result = appendPrimaryColorFilters(base, {
      enabled: true,
      amount: 1,
      exposure: 0.6,
      contrast: 1,
      saturation: 1,
      temperature: 0,
      tint: 0,
      lift: [0, 0, 0],
      gamma: [1, 1, 1],
      gain: [1, 1, 1],
    });
    expect(result).toContain('[vpreprimary]');
    expect(result).toMatch(/\[vpreprimary\]eq=.*\[vout\]$/);
    expect(result).not.toMatch(/null\[vout\]/);
  });
});
