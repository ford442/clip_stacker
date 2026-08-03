import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOISE_REDUCTION,
  isNoiseReductionActive,
  isFinishingActive,
  normalizeFinishingSettings,
} from './finishing';
import {
  NOISE_REDUCTION_UNIFORM_FLOATS,
  appendNoiseReductionFilters,
  buildNoiseReductionFfmpegFilters,
  isNoiseReductionNeutral,
  normalizeNoiseReductionPass,
  packNoiseReductionUniforms,
  shouldResetFinishingTemporal,
} from './noiseReduction';
import { draftNoiseReductionRadius } from './previewBudget';

describe('noise reduction settings', () => {
  it('defaults are inactive until enabled', () => {
    expect(isNoiseReductionActive(DEFAULT_NOISE_REDUCTION)).toBe(false);
    expect(isFinishingActive({ noiseReduction: DEFAULT_NOISE_REDUCTION })).toBe(false);
  });

  it('detects active spatial NR', () => {
    const pass = {
      ...DEFAULT_NOISE_REDUCTION,
      enabled: true,
      spatialStrength: 0.5,
    };
    expect(isNoiseReductionActive(pass)).toBe(true);
    expect(isNoiseReductionNeutral(pass)).toBe(false);
  });

  it('detects active temporal-only NR', () => {
    const pass = {
      ...DEFAULT_NOISE_REDUCTION,
      enabled: true,
      spatialStrength: 0,
      temporal: true,
      temporalStrength: 0.4,
    };
    expect(isNoiseReductionActive(pass)).toBe(true);
  });

  it('ignores temporal when toggle is off', () => {
    const pass = {
      ...DEFAULT_NOISE_REDUCTION,
      enabled: true,
      spatialStrength: 0,
      temporal: false,
      temporalStrength: 0.9,
    };
    expect(isNoiseReductionActive(pass)).toBe(false);
  });

  it('normalizes out-of-range values', () => {
    const normalized = normalizeNoiseReductionPass(
      {
        enabled: true,
        spatialStrength: 2,
        spatialRadius: 99,
        temporalStrength: -1,
        temporalMotionThreshold: 5,
        lumaOnly: false,
        draft: true,
      },
      DEFAULT_NOISE_REDUCTION,
    );
    expect(normalized.spatialStrength).toBe(1);
    expect(normalized.spatialRadius).toBe(4);
    expect(normalized.temporalStrength).toBe(0);
    expect(normalized.temporalMotionThreshold).toBe(1);
    expect(normalized.lumaOnly).toBe(false);
    expect(normalized.draft).toBe(true);
  });

  it('normalizeFinishingSettings restores noise fields', () => {
    const normalized = normalizeFinishingSettings({
      noiseReduction: {
        enabled: true,
        spatialStrength: 0.6,
        spatialRadius: 3,
        temporal: true,
        temporalStrength: 0.25,
        temporalMotionThreshold: 0.1,
        lumaOnly: true,
      },
    });
    expect(normalized.noiseReduction?.enabled).toBe(true);
    expect(normalized.noiseReduction?.spatialStrength).toBe(0.6);
    expect(normalized.noiseReduction?.temporal).toBe(true);
    expect(normalized.noiseReduction?.temporalStrength).toBe(0.25);
  });
});

describe('packNoiseReductionUniforms', () => {
  it('packs 16 floats with texel size and hasPrev', () => {
    const packed = packNoiseReductionUniforms(
      {
        ...DEFAULT_NOISE_REDUCTION,
        enabled: true,
        amount: 1,
        spatialStrength: 0.5,
        spatialRadius: 2,
        temporal: true,
        temporalStrength: 0.3,
      },
      1280,
      720,
      true,
    );
    expect(packed).toHaveLength(NOISE_REDUCTION_UNIFORM_FLOATS);
    expect(packed[0]).toBe(1);
    expect(packed[1]).toBeCloseTo(0.5);
    expect(packed[2]).toBe(2);
    expect(packed[3]).toBeCloseTo(0.3);
    expect(packed[7]).toBe(1); // hasPrev
    expect(packed[8]).toBeCloseTo(1 / 1280);
    expect(packed[9]).toBeCloseTo(1 / 720);
  });

  it('zeros temporal strength when temporal is off', () => {
    const packed = packNoiseReductionUniforms(
      {
        ...DEFAULT_NOISE_REDUCTION,
        enabled: true,
        temporal: false,
        temporalStrength: 0.9,
      },
      100,
      100,
      false,
    );
    expect(packed[3]).toBe(0);
    expect(packed[7]).toBe(0);
  });

  it('caps radius in draft mode', () => {
    const packed = packNoiseReductionUniforms(
      {
        ...DEFAULT_NOISE_REDUCTION,
        enabled: true,
        spatialRadius: 4,
        draft: true,
      },
      100,
      100,
      false,
    );
    expect(packed[2]).toBe(2);
    expect(packed[6]).toBe(1);
  });
});

describe('buildNoiseReductionFfmpegFilters', () => {
  it('returns empty for disabled or neutral', () => {
    expect(buildNoiseReductionFfmpegFilters(undefined)).toBe('');
    expect(buildNoiseReductionFfmpegFilters(DEFAULT_NOISE_REDUCTION)).toBe('');
  });

  it('builds hqdn3d golden string for spatial + temporal', () => {
    const filters = buildNoiseReductionFfmpegFilters({
      enabled: true,
      amount: 1,
      spatialStrength: 0.5,
      spatialRadius: 2,
      temporal: true,
      temporalStrength: 0.4,
      temporalMotionThreshold: 0.08,
      lumaOnly: true,
    });
    expect(filters).toBe(
      'hqdn3d=luma_spatial=3:chroma_spatial=0:luma_tmp=2.4:chroma_tmp=0',
    );
  });

  it('includes chroma when lumaOnly is false', () => {
    const filters = buildNoiseReductionFfmpegFilters({
      enabled: true,
      amount: 1,
      spatialStrength: 0.5,
      spatialRadius: 2,
      temporal: false,
      temporalStrength: 0,
      temporalMotionThreshold: 0.08,
      lumaOnly: false,
    });
    expect(filters).toContain('chroma_spatial=1.95');
  });

  it('appendNoiseReductionFilters rewrites [vout] sink', () => {
    const result = appendNoiseReductionFilters('[0:v]null[vout]', {
      enabled: true,
      amount: 1,
      spatialStrength: 0.5,
      spatialRadius: 2,
      temporal: false,
      temporalStrength: 0,
      temporalMotionThreshold: 0.08,
      lumaOnly: true,
    });
    expect(result).toContain('[vprenoise]');
    expect(result).toMatch(/\[vprenoise\]hqdn3d=.*\[vout\]$/);
  });
});

describe('shouldResetFinishingTemporal', () => {
  it('resets on backward scrub', () => {
    expect(shouldResetFinishingTemporal(1.0, 0.9, false)).toBe(true);
    expect(shouldResetFinishingTemporal(1.0, 0.9, true)).toBe(true);
  });

  it('resets on large paused seek forward', () => {
    expect(shouldResetFinishingTemporal(1.0, 1.0 + 3 / 30, false)).toBe(true);
  });

  it('does not reset on small forward play steps', () => {
    expect(shouldResetFinishingTemporal(1.0, 1.0 + 1 / 30, true)).toBe(false);
    expect(shouldResetFinishingTemporal(1.0, 1.0 + 1 / 30, false)).toBe(false);
  });

  it('does not reset when lastTime is null', () => {
    expect(shouldResetFinishingTemporal(null, 1.0, false)).toBe(false);
  });
});

describe('draftNoiseReductionRadius', () => {
  it('caps radius for preview-height budgets', () => {
    expect(draftNoiseReductionRadius(4, 720)).toBe(2);
    expect(draftNoiseReductionRadius(4, 1080)).toBe(3);
    expect(draftNoiseReductionRadius(1, 720)).toBe(1);
  });
});
