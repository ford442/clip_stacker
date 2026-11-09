import { describe, expect, it } from 'vitest';
import sharpenShader from '../webgpu/shaders/sharpen.wgsl?raw';
import {
  SHARPEN_EDGE_SIGMA,
  SHARPEN_MODE_SLOT,
  SHARPEN_MS_MEDIUM_GAIN,
  SHARPEN_MS_MIDTONE_GAIN,
  SHARPEN_MS_SIGMA_RATIO,
  SHARPEN_MS_WINDOW,
  sharpenImage,
  type RgbImage,
} from './sharpenReference';
import { packSharpenUniforms, type SharpenMode, type SharpenSettings } from './sharpen';

const W = 96;
const H = 48;

/**
 * Rows 0–15: a slightly soft high-contrast edge (0.2 → 0.8 at x = 48).
 * Rows 16–31: a fine texture (±0.1 sinusoid). Rows 32–47: flat 0.5 + noise.
 */
function makePlate(): RgbImage {
  let seed = 9001;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const data = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v: number;
      if (y < 16) v = 0.2 + 0.6 / (1 + Math.exp(-(x - 47.5) / 0.6));
      else if (y < 32) v = 0.5 + 0.1 * Math.sin((2 * Math.PI * x) / 8);
      else v = 0.5 + gauss() * 0.012;
      const c = [v * 0.95, v, v * 0.88];
      for (let k = 0; k < 3; k++) data[(y * W + x) * 3 + k] = c[k];
    }
  }
  return { width: W, height: H, data };
}

const plate = makePlate();
const lumaAt = (img: RgbImage, x: number, y: number) => {
  const i = (y * W + x) * 3;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
};

/** Sum of how far output luma leaves the input's local 5×5 [min, max] — halos + ringing. */
function haloEnergy(out: RgbImage, rows: [number, number]): number {
  let e = 0;
  for (let y = rows[0] + 2; y < rows[1] - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const v = lumaAt(plate, x + i, y + j);
          mn = Math.min(mn, v);
          mx = Math.max(mx, v);
        }
      }
      const v = lumaAt(out, x, y);
      e += Math.max(0, v - mx) + Math.max(0, mn - v);
    }
  }
  return e;
}

/** 10–90 % rise width of the edge (row 8), interpolated. */
function riseWidth(img: RgbImage): number {
  const cross = (t: number) => {
    for (let x = 30; x < 66; x++) {
      const a = lumaAt(img, x, 8);
      const b = lumaAt(img, x + 1, 8);
      if (a <= t && b > t) return x + (t - a) / (b - a);
    }
    return NaN;
  };
  const lo = 0.2 + 0.6 * 0.1;
  const hi = 0.2 + 0.6 * 0.9;
  return cross(hi * 0.9999) - cross(lo);
}

function textureContrast(img: RgbImage): number {
  let mn = Infinity;
  let mx = -Infinity;
  for (let x = 16; x < 80; x++) {
    mn = Math.min(mn, lumaAt(img, x, 24));
    mx = Math.max(mx, lumaAt(img, x, 24));
  }
  return mx - mn;
}

function noiseRms(img: RgbImage): number {
  let s = 0;
  let n = 0;
  for (let y = 36; y < 44; y++) {
    for (let x = 8; x < W - 8; x++) {
      s += (lumaAt(img, x, y) - 0.5) ** 2;
      n++;
    }
  }
  return Math.sqrt(s / n);
}

function settings(mode: SharpenMode, over: Partial<SharpenSettings> = {}): SharpenSettings {
  return { enabled: true, amount: 0.8, radius: 2, threshold: 0.01, midtoneDetail: 0, mode, ...over };
}

const run = (s: SharpenSettings) => sharpenImage(plate, packSharpenUniforms(s, W, H));

describe('sharpen modes (CPU reference of sharpen.wgsl)', () => {
  const classic = run(settings('classic'));
  const edge = run(settings('edge'));
  const multi = run(settings('multiscale'));

  it('classic halos on a high-contrast edge; edge-aware and multi-scale do not', () => {
    const halo = haloEnergy(classic, [0, 16]);
    expect(halo).toBeGreaterThan(0.5);
    expect(haloEnergy(edge, [0, 16])).toBeLessThan(halo * 0.02);
    expect(haloEnergy(multi, [0, 16])).toBeLessThan(halo * 0.02);
  });

  it('still steepens the edge about as much as classic', () => {
    const before = riseWidth(plate);
    const c = riseWidth(classic);
    expect(c).toBeLessThan(before);
    expect(riseWidth(edge)).toBeLessThan(before - (before - c) * 0.8);
    expect(riseWidth(multi)).toBeLessThan(before - (before - c) * 0.6);
  });

  it('keeps most of the texture gain; multi-scale adds micro-contrast', () => {
    const before = textureContrast(plate);
    const c = textureContrast(classic) - before;
    expect(c).toBeGreaterThan(0);
    expect(textureContrast(edge) - before).toBeGreaterThan(c * 0.6);
    expect(textureContrast(multi)).toBeGreaterThan(textureContrast(edge));
  });

  it('amplifies flat-area noise no more than classic (edge-aware)', () => {
    expect(noiseRms(edge)).toBeLessThanOrEqual(noiseRms(classic));
  });

  it('multi-scale midtone detail lifts texture with less noise than classic midtone detail', () => {
    const over = { amount: 0, midtoneDetail: 0.6 };
    const c = run(settings('classic', over));
    const m = run(settings('multiscale', over));
    expect(textureContrast(m)).toBeGreaterThan(textureContrast(c));
    expect(noiseRms(m)).toBeLessThan(noiseRms(c));
  });

  it('keeps source chroma exactly (luma delta added to RGB)', () => {
    for (let i = 0; i < W * H; i += 7) {
      const o = edge.data.slice(i * 3, i * 3 + 3);
      const s = plate.data.slice(i * 3, i * 3 + 3);
      const clipped = [...o].some((v) => v <= 0 || v >= 1);
      if (clipped) continue;
      expect(o[0] - o[1]).toBeCloseTo(s[0] - s[1], 6);
      expect(o[2] - o[1]).toBeCloseTo(s[2] - s[1], 6);
    }
  });

  it('amount 0 and midtone 0 is identity in every mode', () => {
    for (const mode of ['classic', 'edge', 'multiscale'] as const) {
      expect(run(settings(mode, { amount: 0 })).data).toEqual(plate.data);
    }
  });
});

describe('sharpen.wgsl mirrors sharpenReference.ts', () => {
  const constant = (name: string) => {
    const match = new RegExp(`const ${name}: (?:f32|i32) = ([0-9.]+);`).exec(sharpenShader);
    if (!match) throw new Error(`${name} not found in sharpen.wgsl`);
    return Number(match[1]);
  };

  it('shares the mode constants', () => {
    expect(constant('SHARPEN_EDGE_SIGMA')).toBe(SHARPEN_EDGE_SIGMA);
    expect(constant('SHARPEN_MS_SIGMA_RATIO')).toBe(SHARPEN_MS_SIGMA_RATIO);
    expect(constant('SHARPEN_MS_MEDIUM_GAIN')).toBe(SHARPEN_MS_MEDIUM_GAIN);
    expect(constant('SHARPEN_MS_MIDTONE_GAIN')).toBe(SHARPEN_MS_MIDTONE_GAIN);
    expect(constant('SHARPEN_MS_WINDOW')).toBe(SHARPEN_MS_WINDOW);
  });

  it('keeps mode at the packed slot', () => {
    const body = /struct SharpenUniforms \{([\s\S]*?)\n\};/.exec(sharpenShader)?.[1];
    if (!body) throw new Error('SharpenUniforms not found');
    const fields: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      const m = /^([A-Za-z_]\w*)\s*:\s*(f32|vec2<f32>)\s*,$/.exec(line);
      if (!m) throw new Error(`Unexpected field: ${line}`);
      if (m[2] === 'f32') fields.push(m[1]);
      else fields.push(`${m[1]}.x`, `${m[1]}.y`);
    }
    expect(fields).toHaveLength(8);
    expect(fields[SHARPEN_MODE_SLOT]).toBe('mode');
  });
});
