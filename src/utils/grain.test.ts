import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAIN,
  isFinishingActive,
  isGrainActive,
  normalizeFinishingSettings,
} from './finishing';
import {
  GRAIN_AMOUNT_RECOMMENDED,
  GRAIN_BLUR_TAP_LIMIT,
  GRAIN_UNIFORM_FLOATS,
  appendGrainFilters,
  applyGrainFilmStock,
  applyGrainPreset,
  buildGrainBloomFfmpegGraph,
  buildGrainFfmpegFilters,
  grainBlurSigma,
  grainFrameSeedFromTime,
  grainMonochromeBias,
  grainWantsOpticalBlur,
  isotropicGaussianWeight,
  isGrainNeutral,
  normalizeGrainPass,
  packGrainUniforms,
  separableGaussianWeight,
} from './grain';
import { GRAIN_FILM_STOCKS } from './filmGrain';
import { TIMELINE_EXPORT_FPS } from './webcodecs-timeline';

describe('grain settings', () => {
  it('defaults are inactive until enabled', () => {
    expect(isGrainActive(DEFAULT_GRAIN)).toBe(false);
    expect(isFinishingActive({ grain: DEFAULT_GRAIN })).toBe(false);
    expect(DEFAULT_GRAIN.amount).toBe(GRAIN_AMOUNT_RECOMMENDED);
    expect(DEFAULT_GRAIN.monochrome).toBe(true);
    expect(DEFAULT_GRAIN.vignette.enabled).toBe(false);
    expect(DEFAULT_GRAIN.halation.enabled).toBe(false);
  });

  it('detects active grain amount', () => {
    const pass = {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0.4,
      vignette: { ...DEFAULT_GRAIN.vignette },
      halation: { ...DEFAULT_GRAIN.halation },
    };
    expect(isGrainActive(pass)).toBe(true);
    expect(isGrainNeutral(pass)).toBe(false);
  });

  it('amount 0 with optical off is inactive even when enabled', () => {
    const pass = {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0,
      bloomAmount: 0,
      vignette: { ...DEFAULT_GRAIN.vignette, enabled: false },
      halation: { ...DEFAULT_GRAIN.halation, enabled: false },
    };
    expect(isGrainActive(pass)).toBe(false);
    expect(isGrainNeutral(pass)).toBe(true);
  });

  it('detects vignette-only optical activity', () => {
    const pass = {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0,
      vignette: { ...DEFAULT_GRAIN.vignette, enabled: true, amount: 0.3 },
      halation: { ...DEFAULT_GRAIN.halation },
    };
    expect(isGrainActive(pass)).toBe(true);
  });

  it('normalizes out-of-range values', () => {
    const normalized = normalizeGrainPass(
      {
        enabled: true,
        amount: 2,
        size: 99,
        softness: -1,
        monochrome: false,
        bloomAmount: 5,
        vignette: { enabled: true, amount: 2, midpoint: -1, roundness: 3 },
        halation: {
          enabled: true,
          threshold: -0.5,
          amount: 4,
          radius: 100,
        },
      },
      DEFAULT_GRAIN,
    );
    expect(normalized.amount).toBe(1);
    expect(normalized.size).toBe(1);
    expect(normalized.softness).toBe(0);
    expect(normalized.monochrome).toBe(false);
    expect(normalized.bloomAmount).toBe(1);
    expect(normalized.vignette.amount).toBe(1);
    expect(normalized.vignette.midpoint).toBe(0);
    expect(normalized.halation.radius).toBe(32);
  });

  it('fills defaults when grain stub only has enabled/amount', () => {
    const normalized = normalizeGrainPass(
      { enabled: true, amount: 0.3 },
      DEFAULT_GRAIN,
    );
    expect(normalized.size).toBe(DEFAULT_GRAIN.size);
    expect(normalized.softness).toBe(DEFAULT_GRAIN.softness);
    expect(normalized.monochrome).toBe(true);
    expect(normalized.vignette.enabled).toBe(false);
    expect(normalized.halation.enabled).toBe(false);
  });

  it('normalizeFinishingSettings restores grain fields', () => {
    const normalized = normalizeFinishingSettings({
      grain: {
        enabled: true,
        amount: 0.4,
        size: 0.6,
        softness: 0.5,
        monochrome: true,
        bloomAmount: 0.1,
        vignette: { enabled: true, amount: 0.3, midpoint: 0.5, roundness: 0.2 },
        halation: {
          enabled: true,
          threshold: 0.7,
          amount: 0.2,
          radius: 9,
        },
      },
    });
    expect(normalized.grain?.enabled).toBe(true);
    expect(normalized.grain?.amount).toBe(0.4);
    expect(normalized.grain?.size).toBe(0.6);
    expect(normalized.grain?.vignette.enabled).toBe(true);
    expect(normalized.grain?.halation.radius).toBe(9);
  });

  it('applies named presets', () => {
    const applied = applyGrainPreset(
      { ...DEFAULT_GRAIN, enabled: true },
      '16mm',
    );
    expect(applied.enabled).toBe(true);
    expect(applied.amount).toBeGreaterThan(0.4);
    expect(applied.size).toBeGreaterThan(0.5);
    expect(applied.vignette.enabled).toBe(true);
  });
});

describe('grain frame seed plumbing', () => {
  it('quantizes timeline time to integer frame index', () => {
    expect(grainFrameSeedFromTime(0)).toBe(0);
    expect(grainFrameSeedFromTime(1, TIMELINE_EXPORT_FPS)).toBe(
      TIMELINE_EXPORT_FPS,
    );
    expect(grainFrameSeedFromTime(1 / TIMELINE_EXPORT_FPS)).toBe(1);
    expect(grainFrameSeedFromTime(0.5, 30)).toBe(15);
  });

  it('packs frameSeed into uniform slot 7', () => {
    const pass = {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0.5,
      vignette: { ...DEFAULT_GRAIN.vignette },
      halation: { ...DEFAULT_GRAIN.halation },
    };
    const uniforms = packGrainUniforms(pass, 1920, 1080, 42);
    expect(uniforms).toHaveLength(GRAIN_UNIFORM_FLOATS);
    expect(uniforms[0]).toBeCloseTo(0.5);
    expect(uniforms[7]).toBe(42);
    expect(uniforms[12]).toBeCloseTo(1 / 1920);
    expect(uniforms[13]).toBeCloseTo(1 / 1080);
  });

  it('zeros optical amounts when disabled', () => {
    const pass = {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0.2,
      bloomAmount: 0.5,
      vignette: { ...DEFAULT_GRAIN.vignette, enabled: false, amount: 0.9 },
      halation: {
        ...DEFAULT_GRAIN.halation,
        enabled: false,
        amount: 0.9,
      },
    };
    const uniforms = packGrainUniforms(pass, 100, 100, 0);
    expect(uniforms[4]).toBe(0);
    expect(uniforms[8]).toBe(0);
    expect(uniforms[11]).toBeCloseTo(0.5);
  });

  it('amount 0 packs as bypass for grain strength', () => {
    const pass = {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0,
      vignette: { ...DEFAULT_GRAIN.vignette },
      halation: { ...DEFAULT_GRAIN.halation },
    };
    const uniforms = packGrainUniforms(pass, 64, 64, 3);
    expect(uniforms[0]).toBe(0);
    expect(uniforms[7]).toBe(3);
  });
});

describe('grain ffmpeg filters', () => {
  it('builds temporal noise filter', () => {
    const filter = buildGrainFfmpegFilters({
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0.5,
      vignette: { ...DEFAULT_GRAIN.vignette },
      halation: { ...DEFAULT_GRAIN.halation },
    });
    expect(filter).toBe('noise=alls=20:allf=t+u');
  });

  it('includes vignette when enabled', () => {
    const filter = buildGrainFfmpegFilters({
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0.25,
      vignette: {
        enabled: true,
        amount: 0.5,
        midpoint: 0.5,
        roundness: 0.3,
      },
      halation: { ...DEFAULT_GRAIN.halation },
    });
    expect(filter).toContain('noise=alls=');
    expect(filter).toContain('allf=t+u');
    expect(filter).toContain('vignette=angle=');
  });

  it('appends linear grain after [vout]', () => {
    const result = appendGrainFilters('[0:v]null[vout]', {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0.25,
      vignette: { ...DEFAULT_GRAIN.vignette },
      halation: { ...DEFAULT_GRAIN.halation },
    });
    expect(result).toContain('[vpregrain]');
    expect(result).toMatch(/noise=alls=.*:allf=t\+u\[vout\]$/);
  });

  it('appends bloom graph after linear grain', () => {
    const pass = {
      ...DEFAULT_GRAIN,
      enabled: true,
      amount: 0.2,
      bloomAmount: 0.3,
      vignette: { ...DEFAULT_GRAIN.vignette },
      halation: { ...DEFAULT_GRAIN.halation },
    };
    expect(buildGrainBloomFfmpegGraph(pass)).toContain('split[gbase]');
    const result = appendGrainFilters('[0:v]null[vout]', pass);
    expect(result).toContain('[vgrainmid]');
    expect(result).toContain('gblur=sigma=');
    expect(result).toContain('blend=all_mode=screen');
    expect(result).toMatch(/\[vout\]$/);
  });

  it('returns empty when amount is 0 and optical off', () => {
    expect(
      buildGrainFfmpegFilters({
        ...DEFAULT_GRAIN,
        enabled: true,
        amount: 0,
        vignette: { ...DEFAULT_GRAIN.vignette },
        halation: { ...DEFAULT_GRAIN.halation },
      }),
    ).toBe('');
  });
});

describe('separable Gaussian (grain bloom/halation)', () => {
  it('matches the isotropic 2D kernel within float error', () => {
    const sigma = grainBlurSigma(8);
    let maxDelta = 0;
    for (let dy = -GRAIN_BLUR_TAP_LIMIT; dy <= GRAIN_BLUR_TAP_LIMIT; dy++) {
      for (let dx = -GRAIN_BLUR_TAP_LIMIT; dx <= GRAIN_BLUR_TAP_LIMIT; dx++) {
        const a = isotropicGaussianWeight(dx, dy, sigma);
        const b = separableGaussianWeight(dx, dy, sigma);
        maxDelta = Math.max(maxDelta, Math.abs(a - b));
      }
    }
    expect(maxDelta).toBeLessThan(1e-12);
  });

  it('detects optical blur when bloom or halation is on', () => {
    expect(
      grainWantsOpticalBlur({
        ...DEFAULT_GRAIN,
        enabled: true,
        bloomAmount: 0.2,
      }),
    ).toBe(true);
    expect(
      grainWantsOpticalBlur({
        ...DEFAULT_GRAIN,
        enabled: true,
        bloomAmount: 0,
        halation: { ...DEFAULT_GRAIN.halation, enabled: true, amount: 0.3 },
      }),
    ).toBe(true);
    expect(
      grainWantsOpticalBlur({
        ...DEFAULT_GRAIN,
        enabled: true,
        amount: 0.4,
        bloomAmount: 0,
      }),
    ).toBe(false);
  });
});

describe('grain quality modes', () => {
  const base = {
    ...DEFAULT_GRAIN,
    enabled: true,
    amount: 0.5,
    vignette: { ...DEFAULT_GRAIN.vignette },
    halation: { ...DEFAULT_GRAIN.halation },
  };

  it('omitted film fields pack as classic (old projects render unchanged)', () => {
    const uniforms = packGrainUniforms(base, 1920, 1080, 5);
    expect(uniforms[16]).toBe(0);
    expect(uniforms[17]).toBe(1); // monochrome: true
    expect(uniforms[18]).toBe(0);
    expect(Array.from(uniforms.slice(20, 23))).toEqual([1, 1, 1]);
    expect(packGrainUniforms({ ...base, monochrome: false }, 64, 64, 0)[17]).toBe(0);
  });

  it('packs film quality, bias, coherence and response', () => {
    const uniforms = packGrainUniforms(
      {
        ...base,
        quality: 'film',
        monochromeBias: 0.25,
        temporalCoherence: 3,
        response: { shadows: 1.5, midtones: 1, highlights: 0.5 },
      },
      1920,
      1080,
      5,
    );
    expect(uniforms[16]).toBe(1);
    expect(uniforms[17]).toBeCloseTo(0.25);
    expect(uniforms[18]).toBe(1);
    expect(Array.from(uniforms.slice(20, 23))).toEqual([1.5, 1, 0.5]);
  });

  it('normalize does not add film keys to a legacy grain pass', () => {
    const normalized = normalizeGrainPass({ enabled: true, amount: 0.3 }, DEFAULT_GRAIN);
    expect(normalized).not.toHaveProperty('quality');
    expect(normalized).not.toHaveProperty('monochromeBias');
    expect(normalized).not.toHaveProperty('temporalCoherence');
    expect(normalized).not.toHaveProperty('response');
    expect(normalizeFinishingSettings({}).grain).not.toHaveProperty('quality');
  });

  it('normalize round-trips and clamps film fields', () => {
    const normalized = normalizeGrainPass(
      {
        enabled: true,
        quality: 'film',
        monochromeBias: 4,
        temporalCoherence: -1,
        response: { shadows: 3, midtones: 0.8, highlights: 0.2 },
      },
      DEFAULT_GRAIN,
    );
    expect(normalized.quality).toBe('film');
    expect(normalized.monochromeBias).toBe(1);
    expect(normalized.temporalCoherence).toBe(0);
    expect(normalized.response).toEqual({ shadows: 2, midtones: 0.8, highlights: 0.2 });
    expect(
      normalizeGrainPass({ enabled: true, quality: 'bogus' as never }, DEFAULT_GRAIN),
    ).not.toHaveProperty('quality');
  });

  it('film stocks switch to film quality and keep optical + coherence', () => {
    const current = {
      ...base,
      temporalCoherence: 0.4,
      vignette: { ...base.vignette, enabled: true, amount: 0.6 },
    };
    const next = applyGrainFilmStock(current, '16mm');
    const stock = GRAIN_FILM_STOCKS.find((s) => s.id === '16mm')!;
    expect(next.quality).toBe('film');
    expect(next.enabled).toBe(true);
    expect(next.size).toBe(stock.size);
    expect(next.softness).toBe(stock.softness);
    expect(next.amount).toBe(stock.amount);
    expect(next.monochromeBias).toBe(stock.monochromeBias);
    expect(next.response).toEqual(stock.response);
    expect(next.temporalCoherence).toBe(0.4);
    expect(next.vignette.amount).toBe(0.6);
    expect(applyGrainFilmStock(current, 'nope' as never)).toBe(current);
  });

  it('grainMonochromeBias falls back to the classic toggle', () => {
    expect(grainMonochromeBias({ ...base, monochrome: true })).toBe(1);
    expect(grainMonochromeBias({ ...base, monochrome: false })).toBe(0);
    expect(grainMonochromeBias({ ...base, monochromeBias: 0.3 })).toBe(0.3);
  });
});
