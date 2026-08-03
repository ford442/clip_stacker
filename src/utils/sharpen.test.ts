import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHARPEN,
  isFinishingActive,
  isSharpenActive,
  normalizeFinishingSettings,
} from './finishing';
import {
  SHARPEN_AMOUNT_RECOMMENDED,
  SHARPEN_AMOUNT_SOFT_CAP,
  SHARPEN_UNIFORM_FLOATS,
  appendSharpenFilters,
  buildSharpenFfmpegFilters,
  isSharpenNeutral,
  normalizeSharpenPass,
  packSharpenUniforms,
  sharpenRadiusToMsize,
} from './sharpen';

describe('sharpen settings', () => {
  it('defaults are inactive until enabled', () => {
    expect(isSharpenActive(DEFAULT_SHARPEN)).toBe(false);
    expect(isFinishingActive({ sharpen: DEFAULT_SHARPEN })).toBe(false);
    expect(DEFAULT_SHARPEN.amount).toBe(SHARPEN_AMOUNT_RECOMMENDED);
  });

  it('detects active sharpen amount', () => {
    const pass = {
      ...DEFAULT_SHARPEN,
      enabled: true,
      amount: 0.2,
    };
    expect(isSharpenActive(pass)).toBe(true);
    expect(isSharpenNeutral(pass)).toBe(false);
  });

  it('detects midtone-only sharpen', () => {
    const pass = {
      ...DEFAULT_SHARPEN,
      enabled: true,
      amount: 0,
      midtoneDetail: 0.4,
    };
    expect(isSharpenActive(pass)).toBe(true);
  });

  it('amount 0 with midtone 0 is inactive even when enabled', () => {
    const pass = {
      ...DEFAULT_SHARPEN,
      enabled: true,
      amount: 0,
      midtoneDetail: 0,
    };
    expect(isSharpenActive(pass)).toBe(false);
  });

  it('normalizes out-of-range values', () => {
    const normalized = normalizeSharpenPass(
      {
        enabled: true,
        amount: 2,
        radius: 99,
        threshold: -1,
        midtoneDetail: 5,
      },
      DEFAULT_SHARPEN,
    );
    expect(normalized.amount).toBe(1);
    expect(normalized.radius).toBe(3);
    expect(normalized.threshold).toBe(0);
    expect(normalized.midtoneDetail).toBe(1);
  });

  it('normalizeFinishingSettings restores sharpen fields', () => {
    const normalized = normalizeFinishingSettings({
      sharpen: {
        enabled: true,
        amount: 0.2,
        radius: 1.5,
        threshold: 0.04,
        midtoneDetail: 0.25,
      },
    });
    expect(normalized.sharpen?.enabled).toBe(true);
    expect(normalized.sharpen?.amount).toBe(0.2);
    expect(normalized.sharpen?.radius).toBe(1.5);
    expect(normalized.sharpen?.threshold).toBe(0.04);
    expect(normalized.sharpen?.midtoneDetail).toBe(0.25);
  });

  it('fills defaults when sharpen stub only has enabled/amount', () => {
    const normalized = normalizeSharpenPass(
      { enabled: true, amount: 0.3 },
      DEFAULT_SHARPEN,
    );
    expect(normalized.radius).toBe(1);
    expect(normalized.threshold).toBe(0.02);
    expect(normalized.midtoneDetail).toBe(0);
  });
});

describe('packSharpenUniforms', () => {
  it('packs 8 floats with texel size', () => {
    const packed = packSharpenUniforms(
      {
        enabled: true,
        amount: 0.2,
        radius: 1.5,
        threshold: 0.03,
        midtoneDetail: 0.1,
      },
      1920,
      1080,
    );
    expect(packed.length).toBe(SHARPEN_UNIFORM_FLOATS);
    expect(packed[0]).toBeCloseTo(0.2);
    expect(packed[1]).toBeCloseTo(1.5);
    expect(packed[2]).toBeCloseTo(0.03);
    expect(packed[3]).toBeCloseTo(0.1);
    expect(packed[4]).toBeCloseTo(1 / 1920);
    expect(packed[5]).toBeCloseTo(1 / 1080);
  });

  it('zeros amount when disabled (bypass)', () => {
    const packed = packSharpenUniforms(
      {
        enabled: false,
        amount: 0.5,
        radius: 1,
        threshold: 0.02,
        midtoneDetail: 0.5,
      },
      100,
      100,
    );
    expect(packed[0]).toBe(0);
    expect(packed[3]).toBe(0);
  });
});

describe('sharpen FFmpeg filters', () => {
  it('returns empty when disabled or amount 0', () => {
    expect(buildSharpenFfmpegFilters(undefined)).toBe('');
    expect(buildSharpenFfmpegFilters(DEFAULT_SHARPEN)).toBe('');
    expect(
      buildSharpenFfmpegFilters({
        ...DEFAULT_SHARPEN,
        enabled: true,
        amount: 0,
        midtoneDetail: 0,
      }),
    ).toBe('');
  });

  it('builds unsharp with luma-only chroma_amount=0', () => {
    const filter = buildSharpenFfmpegFilters({
      enabled: true,
      amount: 0.2,
      radius: 1,
      threshold: 0.02,
      midtoneDetail: 0,
    });
    expect(filter).toBe(
      'unsharp=luma_msize_x=3:luma_msize_y=3:luma_amount=0.5:chroma_amount=0',
    );
  });

  it('maps larger radius to larger msize', () => {
    expect(sharpenRadiusToMsize(0.5)).toBe(3);
    expect(sharpenRadiusToMsize(1)).toBe(3);
    expect(sharpenRadiusToMsize(2)).toBe(5);
    expect(sharpenRadiusToMsize(3)).toBe(7);
  });

  it('appends mild eq when midtone detail is set', () => {
    const filter = buildSharpenFfmpegFilters({
      enabled: true,
      amount: 0.15,
      radius: 1,
      threshold: 0.02,
      midtoneDetail: 0.5,
    });
    expect(filter).toContain('unsharp=');
    expect(filter).toContain('eq=contrast=1.06');
  });

  it('appendSharpenFilters rewrites [vout] sink', () => {
    const result = appendSharpenFilters('[0:v]null[vout]', {
      enabled: true,
      amount: 0.2,
      radius: 1,
      threshold: 0.02,
      midtoneDetail: 0,
    });
    expect(result).toContain('[vpresharp]');
    expect(result).toContain('unsharp=');
    expect(result.endsWith('[vout]')).toBe(true);
  });

  it('documents soft-cap constant used by UI', () => {
    expect(SHARPEN_AMOUNT_SOFT_CAP).toBe(0.3);
    expect(SHARPEN_AMOUNT_RECOMMENDED).toBeLessThanOrEqual(SHARPEN_AMOUNT_SOFT_CAP);
  });
});
