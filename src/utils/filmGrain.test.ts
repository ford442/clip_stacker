import { describe, expect, it } from 'vitest';
import grainShader from '../webgpu/shaders/grain.wgsl?raw';
import {
  FILM_GRAIN_MAX_HOLD_FRAMES,
  FILM_GRAIN_NORM,
  FILM_GRAIN_OCTAVE2_SCALE,
  FILM_GRAIN_OCTAVE2_WEIGHT,
  FILM_GRAIN_RMS,
  FLAT_GRAIN_RESPONSE,
  GRAIN_FILM_STOCKS,
  filmGrainField,
  filmGrainRgb,
  grainResponseAt,
  grainTemporalBlend,
  normalizeGrainResponse,
  pcg4d,
} from './filmGrain';

/** Independent PCG4D over BigInt, to pin the 32-bit wrapping of the Math.imul version. */
function pcg4dBig(x: number, y: number, z: number, w: number): number[] {
  const M = (1n << 32n) - 1n;
  const v = [x, y, z, w].map((n) => (BigInt(n >>> 0) * 1664525n + 1013904223n) & M);
  const mixRound = () => {
    v[0] = (v[0] + v[1] * v[3]) & M;
    v[1] = (v[1] + v[2] * v[0]) & M;
    v[2] = (v[2] + v[0] * v[1]) & M;
    v[3] = (v[3] + v[1] * v[2]) & M;
  };
  mixRound();
  for (let i = 0; i < 4; i++) v[i] ^= v[i] >> 16n;
  mixRound();
  return v.map(Number);
}

function stats(values: number[]): { mean: number; rms: number } {
  let sum = 0;
  let sum2 = 0;
  for (const v of values) {
    sum += v;
    sum2 += v * v;
  }
  return { mean: sum / values.length, rms: Math.sqrt(sum2 / values.length) };
}

describe('pcg4d', () => {
  it('matches a BigInt reference, including negative lattice cells', () => {
    const inputs: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [1, 2, 3, 4],
      [-1, -7, 123456, 1],
      [2_000_000_000, -2_000_000_000, 4_000_000, 0],
    ];
    for (const [x, y, z, w] of inputs) {
      expect(pcg4d(x, y, z, w)).toEqual(pcg4dBig(x, y, z, w));
    }
  });
});

describe('film grain field', () => {
  it('is deterministic per (position, frame) and changes with the frame', () => {
    expect(filmGrainField(12.3, 45.6, 7)).toEqual(filmGrainField(12.3, 45.6, 7));
    expect(filmGrainField(12.3, 45.6, 7)).not.toEqual(filmGrainField(12.3, 45.6, 8));
  });

  it('is zero-mean with unit RMS (FILM_GRAIN_NORM is calibrated)', () => {
    const values: number[] = [];
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 120; x++) {
        values.push(...filmGrainField(x * 0.37 + 0.13, y * 0.41 + 0.07, 11));
      }
    }
    const { mean, rms } = stats(values);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(rms).toBeGreaterThan(0.95);
    expect(rms).toBeLessThan(1.05);
  });

  it('is blue: little energy survives a 4×4-cell box average', () => {
    // Unit-RMS white value noise keeps ~0.075 of its variance in 4×4-cell block
    // means; the Laplacian lattice must stay far below that (no mottling).
    let sum2 = 0;
    let blocks = 0;
    for (let by = 0; by < 24; by++) {
      for (let bx = 0; bx < 24; bx++) {
        let m = 0;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            m += filmGrainField(bx * 4 + x * 0.25 + 0.1, by * 4 + y * 0.25 + 0.1, 3)[0];
          }
        }
        m /= 256;
        sum2 += m * m;
        blocks++;
      }
    }
    expect(sum2 / blocks).toBeLessThan(0.01);
  });
});

describe('film grain temporal coherence', () => {
  const correlation = (coherence: number, f0: number, f1: number) => {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) {
        const a = filmGrainRgb(x / 50, y / 50, 16 / 9, 0.5, 1, f0, coherence)[0];
        const b = filmGrainRgb(x / 50, y / 50, 16 / 9, 0.5, 1, f1, coherence)[0];
        ab += a * b;
        aa += a * a;
        bb += b * b;
      }
    }
    return ab / Math.sqrt(aa * bb);
  };

  it('coherence 0 is a fresh, uncorrelated field every frame', () => {
    expect(grainTemporalBlend(41, 0)).toEqual({ key: 41, weight: 0, norm: 1 });
    expect(Math.abs(correlation(0, 10, 11))).toBeLessThan(0.1);
  });

  it('higher coherence correlates neighbouring frames', () => {
    expect(correlation(0.5, 10, 11)).toBeGreaterThan(0.8);
    expect(correlation(1, 10, 11)).toBeGreaterThan(0.95);
    // Still evolves: a full hold later the field is new.
    expect(Math.abs(correlation(1, 0, FILM_GRAIN_MAX_HOLD_FRAMES * 2))).toBeLessThan(0.1);
  });

  it('keeps grain strength steady between keys (no pumping)', () => {
    const rmsAt = (frame: number) => {
      const values: number[] = [];
      for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 60; x++) {
          values.push(...filmGrainRgb(x / 60 + 0.003, y / 60, 16 / 9, 0.3, 0.5, frame, 1));
        }
      }
      return stats(values).rms;
    };
    for (const frame of [0, 3, 6, 9]) {
      expect(rmsAt(frame)).toBeGreaterThan(0.9);
      expect(rmsAt(frame)).toBeLessThan(1.1);
    }
  });
});

describe('film grain colour + response', () => {
  it('monochrome bias 1 gives identical channels; 0 gives independent ones', () => {
    const [r, g, b] = filmGrainRgb(0.3, 0.6, 1.5, 0.4, 1, 9, 0);
    expect(r).toBeCloseTo(g, 12);
    expect(g).toBeCloseTo(b, 12);
    const colour = filmGrainRgb(0.3, 0.6, 1.5, 0.4, 0, 9, 0);
    expect(colour[0]).not.toBeCloseTo(colour[1], 3);
  });

  it('response curve passes through its three control points', () => {
    const curve = { shadows: 1.3, midtones: 1, highlights: 0.4 };
    expect(grainResponseAt(curve, 0)).toBeCloseTo(1.3);
    expect(grainResponseAt(curve, 0.5)).toBeCloseTo(1);
    expect(grainResponseAt(curve, 1)).toBeCloseTo(0.4);
    expect(grainResponseAt(FLAT_GRAIN_RESPONSE, 0.27)).toBe(1);
  });

  it('normalizes untrusted response values', () => {
    expect(normalizeGrainResponse({ shadows: 9, midtones: -1 })).toEqual({
      shadows: 2,
      midtones: 0,
      highlights: 1,
    });
    expect(normalizeGrainResponse(undefined)).toEqual(FLAT_GRAIN_RESPONSE);
  });

  it('film stocks are in range data with unique ids', () => {
    const ids = new Set(GRAIN_FILM_STOCKS.map((s) => s.id));
    expect(ids.size).toBe(GRAIN_FILM_STOCKS.length);
    for (const stock of GRAIN_FILM_STOCKS) {
      for (const v of [stock.amount, stock.size, stock.softness, stock.monochromeBias]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(normalizeGrainResponse(stock.response)).toEqual(stock.response);
    }
  });
});

describe('grain.wgsl mirrors filmGrain.ts', () => {
  const constant = (name: string) => {
    const match = new RegExp(`const ${name}: f32 = ([0-9.]+);`).exec(grainShader);
    if (!match) throw new Error(`${name} not found in grain.wgsl`);
    return Number(match[1]);
  };

  it('shares the calibration constants', () => {
    expect(constant('FILM_GRAIN_NORM')).toBe(FILM_GRAIN_NORM);
    expect(constant('FILM_GRAIN_RMS')).toBe(FILM_GRAIN_RMS);
    expect(constant('FILM_GRAIN_OCTAVE2_SCALE')).toBe(FILM_GRAIN_OCTAVE2_SCALE);
    expect(constant('FILM_GRAIN_OCTAVE2_WEIGHT')).toBe(FILM_GRAIN_OCTAVE2_WEIGHT);
    expect(constant('FILM_GRAIN_MAX_HOLD_FRAMES')).toBe(FILM_GRAIN_MAX_HOLD_FRAMES);
  });
});
