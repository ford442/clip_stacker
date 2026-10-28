import { describe, expect, it } from 'vitest';
import denoiseShader from '../webgpu/shaders/denoise.wgsl?raw';
import {
  NR_HIGH_CUTOFF_MAX,
  NR_HIGH_CUTOFF_MIN,
  NR_HIGH_MAX_REACH,
  NR_HIGH_RADIUS_SCALE,
  NR_NLM_H_MAX,
  NR_NLM_H_MIN,
  NR_NLM_MAX_SEARCH,
  NR_QUALITY_SLOT,
  denoiseImage,
  tukey,
  type RgbImage,
} from './denoiseReference';
import {
  packNoiseReductionUniforms,
  type NoiseReductionQuality,
  type NoiseReductionSettings,
} from './noiseReduction';

const W = 120;
const H = 80;
const EDGE_X = 60;
const LINE_Y = 40;

/** Clean test plate: a vertical step edge, a 1 px bright line, a gradient strip. */
function cleanValue(x: number, y: number): number {
  if (y > 60) return 0.2 + (0.6 * x) / W;
  if (y === LINE_Y) return 0.95;
  return x < EDGE_X ? 0.25 : 0.7;
}

function makePlates(): { clean: RgbImage; noisy: RgbImage } {
  let seed = 4242;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const clean = new Float32Array(W * H * 3);
  const noisy = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = cleanValue(x, y);
      const c = [v * 0.9, v, Math.min(1, v * 1.1)];
      const lumaNoise = gauss() * 0.05;
      for (let k = 0; k < 3; k++) {
        const i = (y * W + x) * 3 + k;
        clean[i] = c[k];
        // Shared luma noise + independent per-channel (chroma) noise.
        noisy[i] = Math.min(1, Math.max(0, c[k] + lumaNoise + gauss() * 0.02));
      }
    }
  }
  return {
    clean: { width: W, height: H, data: clean },
    noisy: { width: W, height: H, data: noisy },
  };
}

const { clean, noisy } = makePlates();

const lumaAt = (d: Float32Array, i: number) =>
  0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** RMS luma error vs the clean plate in three regions, plus chroma RMS. */
function errors(img: RgbImage) {
  const acc = { flat: [0, 0], edge: [0, 0], line: [0, 0], chroma: [0, 0] };
  for (let y = 4; y < H - 4; y++) {
    for (let x = 4; x < W - 4; x++) {
      const i = (y * W + x) * 3;
      const e = lumaAt(img.data, i) - lumaAt(clean.data, i);
      for (let k = 0; k < 3; k++) {
        const c =
          img.data[i + k] - lumaAt(img.data, i) - (clean.data[i + k] - lumaAt(clean.data, i));
        acc.chroma[0] += c * c;
        acc.chroma[1]++;
      }
      let bucket: number[] | null = null;
      if (y === LINE_Y && Math.abs(x - EDGE_X) > 6) bucket = acc.line;
      else if (Math.abs(x - EDGE_X) <= 1 && y < LINE_Y - 4) bucket = acc.edge;
      else if (Math.abs(x - EDGE_X) > 6 && Math.abs(y - LINE_Y) > 6 && y < 56) bucket = acc.flat;
      if (bucket) {
        bucket[0] += e * e;
        bucket[1]++;
      }
    }
  }
  const rms = ([s, n]: number[]) => Math.sqrt(s / n);
  return {
    flat: rms(acc.flat),
    edge: rms(acc.edge),
    line: rms(acc.line),
    chroma: rms(acc.chroma),
  };
}

function settings(
  quality: NoiseReductionQuality,
  over: Partial<NoiseReductionSettings> = {},
): NoiseReductionSettings {
  return {
    enabled: true,
    amount: 1,
    spatialStrength: 0.8,
    spatialRadius: 2,
    temporal: false,
    temporalStrength: 0,
    temporalMotionThreshold: 0.08,
    lumaOnly: true,
    quality,
    ...over,
  };
}

const run = (img: RgbImage, s: NoiseReductionSettings) =>
  denoiseImage(img, packNoiseReductionUniforms(s, W, H, false));

describe('denoise quality tiers (CPU reference of denoise.wgsl)', () => {
  const before = errors(noisy);
  const standard = errors(run(noisy, settings('standard')));
  const high = errors(run(noisy, settings('high')));
  const nlm = errors(run(noisy, settings('nlm')));

  it('every tier removes noise', () => {
    for (const e of [standard, high, nlm]) {
      expect(e.flat).toBeLessThan(before.flat);
      expect(e.edge).toBeLessThan(before.edge);
    }
  });

  it('high and nlm denoise flat areas harder than standard', () => {
    expect(high.flat).toBeLessThan(standard.flat * 0.85);
    expect(nlm.flat).toBeLessThan(standard.flat * 0.85);
  });

  it('high and nlm retain the step edge better than standard', () => {
    expect(high.edge).toBeLessThan(standard.edge * 0.8);
    expect(nlm.edge).toBeLessThan(standard.edge);
  });

  it('keeps a 1 px line at least as well as standard', () => {
    const s = settings('standard', { spatialStrength: 0.45 });
    const lineStandard = errors(run(noisy, s)).line;
    expect(errors(run(noisy, { ...s, quality: 'high' })).line).toBeLessThanOrEqual(lineStandard);
    expect(errors(run(noisy, { ...s, quality: 'nlm' })).line).toBeLessThan(lineStandard);
  });

  it('cleans chroma noise when Luma only is off (and leaves it alone when on)', () => {
    const chroma = (q: NoiseReductionQuality) =>
      errors(run(noisy, settings(q, { lumaOnly: false }))).chroma;
    expect(chroma('high')).toBeLessThan(before.chroma * 0.6);
    expect(chroma('nlm')).toBeLessThan(before.chroma * 0.6);
    expect(chroma('high')).toBeLessThan(chroma('standard'));
    // Luma only keeps source chroma exactly on the new tiers (standard's YUV
    // round trip is lossy, which is kept for byte-compatibility).
    expect(high.chroma).toBeCloseTo(before.chroma, 4);
    expect(nlm.chroma).toBeCloseTo(before.chroma, 4);
  });

  it('blurs a clean plate no more than standard (edge retention without noise)', () => {
    const change = (q: NoiseReductionQuality) => {
      const out = run(clean, settings(q, { spatialStrength: 1, spatialRadius: 4 }));
      let s = 0;
      for (let i = 0; i < W * H * 3; i += 3) {
        const d = lumaAt(out.data, i) - lumaAt(clean.data, i);
        s += d * d;
      }
      return Math.sqrt(s / (W * H));
    };
    expect(change('high')).toBeLessThanOrEqual(change('standard'));
  });

  it('amount 0 and strength 0 are identity', () => {
    for (const q of ['high', 'nlm'] as const) {
      expect(run(noisy, settings(q, { amount: 0 })).data).toEqual(noisy.data);
      const zero = run(noisy, settings(q, { spatialStrength: 0 })).data;
      for (let i = 0; i < zero.length; i++) {
        expect(zero[i]).toBeCloseTo(noisy.data[i], 6);
      }
    }
  });
});

describe('tukey edge stop', () => {
  it('is 1 at zero, falls smoothly, and is exactly 0 past the cutoff', () => {
    expect(tukey(0)).toBe(1);
    expect(tukey(0.5)).toBeCloseTo(0.5625);
    expect(tukey(-0.5)).toBe(tukey(0.5));
    expect(tukey(1)).toBe(0);
    expect(tukey(3)).toBe(0);
  });
});

describe('denoise.wgsl mirrors denoiseReference.ts', () => {
  const constant = (name: string) => {
    const match = new RegExp(`const ${name}: (?:f32|i32) = ([0-9.]+);`).exec(denoiseShader);
    if (!match) throw new Error(`${name} not found in denoise.wgsl`);
    return Number(match[1]);
  };

  it('shares the tier constants', () => {
    expect(constant('NR_HIGH_RADIUS_SCALE')).toBe(NR_HIGH_RADIUS_SCALE);
    expect(constant('NR_HIGH_MAX_REACH')).toBe(NR_HIGH_MAX_REACH);
    expect(constant('NR_HIGH_CUTOFF_MIN')).toBe(NR_HIGH_CUTOFF_MIN);
    expect(constant('NR_HIGH_CUTOFF_MAX')).toBe(NR_HIGH_CUTOFF_MAX);
    expect(constant('NR_NLM_H_MIN')).toBe(NR_NLM_H_MIN);
    expect(constant('NR_NLM_H_MAX')).toBe(NR_NLM_H_MAX);
    expect(constant('NR_NLM_MAX_SEARCH')).toBe(NR_NLM_MAX_SEARCH);
  });

  it('keeps quality at the packed slot', () => {
    const body = /struct NoiseReductionUniforms \{([\s\S]*?)\n\};/.exec(denoiseShader)?.[1];
    if (!body) throw new Error('NoiseReductionUniforms not found');
    const fields: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      const m = /^([A-Za-z_]\w*)\s*:\s*(f32|vec2<f32>|vec4<f32>)\s*,$/.exec(line);
      if (!m) throw new Error(`Unexpected field: ${line}`);
      const width = m[2] === 'f32' ? 1 : m[2] === 'vec2<f32>' ? 2 : 4;
      for (let k = 0; k < width; k++) fields.push(width === 1 ? m[1] : `${m[1]}.${k}`);
    }
    expect(fields).toHaveLength(16);
    expect(fields[NR_QUALITY_SLOT]).toBe('quality');
    expect(fields[7]).toBe('hasPrev');
  });
});
