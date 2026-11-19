/**
 * Byte parity of the spec-driven packers against the hand-written packers
 * they replaced (copied verbatim into `__legacy_*` modules for this test
 * only). Fuzzes each pass's settings around its defaults — out-of-range,
 * NaN, missing and unknown-mode values included — and requires the two
 * outputs to be byte-identical.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FINISHING } from '../finishing/finishing';
import { packGrainUniforms } from '../finishing/grain';
import { packGrainUniforms as legacyGrain } from '../finishing/__legacy_grain';
import { packSharpenUniforms } from '../finishing/sharpen';
import { packSharpenUniforms as legacySharpen } from '../finishing/__legacy_sharpen';
import { packNoiseReductionUniforms } from '../finishing/noiseReduction';
import { packNoiseReductionUniforms as legacyNoise } from '../finishing/__legacy_noiseReduction';
import { packCurvesUniforms } from '../finishing/curves';
import { packCurvesUniforms as legacyCurves } from '../finishing/__legacy_curves';
import { packBloomUniforms } from '../finishing/bloom';
import { packBloomUniforms as legacyBloom } from '../finishing/__legacy_bloom';
import { packChromaticAberrationUniforms } from '../finishing/chromaticAberration';
import { packChromaticAberrationUniforms as legacyCa } from '../finishing/__legacy_chromaticAberration';
import { packLayerUniforms, type LayerRenderParams } from './previewLayerUniforms';
import { packLayerUniforms as legacyLayer } from './__legacy_previewLayerUniforms';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MODES = ['classic', 'film', 'edge', 'multiscale', 'standard', 'high', 'nlm', 'bloom', 'lightWrap', 'bogus'];

/** Perturb a settings object: each leaf may become out of range, NaN, missing or another mode. */
function fuzz<T>(base: T, rand: () => number): T {
  if (Array.isArray(base)) return base.map((v) => fuzz(v, rand)) as T;
  if (base && typeof base === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) {
      const r = rand();
      if (r < 0.08) continue;
      out[key] = fuzz(value, rand);
    }
    if (rand() < 0.3) out.quality = MODES[Math.floor(rand() * MODES.length)];
    if (rand() < 0.3) out.mode = MODES[Math.floor(rand() * MODES.length)];
    return out as T;
  }
  if (typeof base === 'number') {
    const r = rand();
    if (r < 0.05) return Number.NaN as T;
    if (r < 0.1) return Infinity as T;
    return ((rand() - 0.25) * 3 * (Math.abs(base) + 1)) as T;
  }
  if (typeof base === 'boolean') return (rand() < 0.6) as T;
  return base;
}

function bytes(a: Float32Array): number[] {
  return Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

/** A buffer full of garbage, so a slot the new packer forgets to write shows up. */
function dirty(n: number, rand: () => number): Float32Array {
  return Float32Array.from({ length: n }, () => rand() * 1000 - 500);
}

function twin(n: number, rand: () => number): [Float32Array, Float32Array] {
  const a = dirty(n, rand);
  return [a, a.slice()];
}

const CASES = 400;

describe('spec packers are byte-identical to the legacy packers', () => {
  it('grain', () => {
    const rand = rng(1);
    for (let i = 0; i < CASES; i++) {
      const pass = fuzz({ ...DEFAULT_FINISHING.grain!, enabled: true }, rand);
      const w = Math.floor(rand() * 4000) - 10;
      const h = Math.floor(rand() * 3000) - 10;
      const seed = rand() < 0.1 ? Number.NaN : rand() * 1e6 - 10;
      const [a, b] = twin(24, rand);
      expect(bytes(packGrainUniforms(pass, w, h, seed, a))).toEqual(bytes(legacyGrain(pass, w, h, seed, b)));
    }
  });

  it('sharpen', () => {
    const rand = rng(2);
    for (let i = 0; i < CASES; i++) {
      const pass = fuzz({ ...DEFAULT_FINISHING.sharpen!, enabled: true }, rand);
      const w = Math.floor(rand() * 4000) - 10;
      const h = Math.floor(rand() * 3000) - 10;
      const [a, b] = twin(8, rand);
      expect(bytes(packSharpenUniforms(pass, w, h, a))).toEqual(bytes(legacySharpen(pass, w, h, b)));
    }
  });

  it('noise reduction', () => {
    const rand = rng(3);
    for (let i = 0; i < CASES; i++) {
      const pass = fuzz({ ...DEFAULT_FINISHING.noiseReduction!, enabled: true, temporal: true }, rand);
      const w = Math.floor(rand() * 4000) - 10;
      const h = Math.floor(rand() * 3000) - 10;
      const prev = rand() < 0.5;
      const [a, b] = twin(16, rand);
      expect(bytes(packNoiseReductionUniforms(pass, w, h, prev, a))).toEqual(
        bytes(legacyNoise(pass, w, h, prev, b)),
      );
    }
  });

  it('curves', () => {
    const rand = rng(4);
    for (let i = 0; i < CASES; i++) {
      const base = DEFAULT_FINISHING.curves!;
      const knots = () =>
        Array.from({ length: Math.floor(rand() * 20) }, () => ({ x: rand() * 1.2 - 0.1, y: rand() * 1.2 - 0.1 }));
      const pass = fuzz(
        {
          ...base,
          enabled: true,
          curves: { master: knots(), red: knots(), green: knots(), blue: knots() },
        },
        rand,
      );
      const [a, b] = twin(268, rand);
      expect(bytes(packCurvesUniforms(pass, a))).toEqual(bytes(legacyCurves(pass, b)));
    }
  });

  it('bloom', () => {
    const rand = rng(5);
    for (let i = 0; i < CASES; i++) {
      const pass = fuzz({ ...DEFAULT_FINISHING.bloom!, enabled: true }, rand);
      const w = Math.floor(rand() * 4000) - 10;
      const h = Math.floor(rand() * 3000) - 10;
      const weight = rand();
      const norm = rand();
      const [a, b] = twin(12, rand);
      expect(bytes(packBloomUniforms(pass, w, h, weight, norm, a))).toEqual(
        bytes(legacyBloom(pass, w, h, weight, norm, b)),
      );
    }
  });

  it('chromatic aberration', () => {
    const rand = rng(6);
    for (let i = 0; i < CASES; i++) {
      const pass = fuzz({ ...DEFAULT_FINISHING.chromaticAberration!, enabled: true }, rand);
      const w = Math.floor(rand() * 4000) - 10;
      const h = Math.floor(rand() * 3000) - 10;
      const [a, b] = twin(8, rand);
      expect(bytes(packChromaticAberrationUniforms(pass, w, h, a))).toEqual(bytes(legacyCa(pass, w, h, b)));
    }
  });

  it('preview layer (key, warp, quad, audio-reactive)', () => {
    const rand = rng(7);
    for (let i = 0; i < CASES; i++) {
      const params: LayerRenderParams = {
        elapsed: rand() * 10,
        duration: rand() * 10,
        fadeIn: rand(),
        fadeOut: rand(),
        opacity: rand(),
        uvScale: [rand(), rand()],
        uvOffset: [rand(), rand()],
        ...(rand() < 0.5 ? { warpMatrix: [rand(), rand(), rand(), rand(), rand(), rand()] as const } : {}),
        ...(rand() < 0.5 ? { warpQuad: { x: rand(), y: rand(), w: rand(), h: rand() } } : {}),
        ...(rand() < 0.5
          ? {
              key: {
                mode: rand() < 0.5 ? (1 as const) : (2 as const),
                keyR: rand(),
                keyG: rand(),
                keyB: rand(),
                similarity: rand(),
                blend: rand(),
              },
            }
          : {}),
        ...(rand() < 0.5 ? { destRect: { x: rand(), y: rand(), w: rand(), h: rand() } } : {}),
        ...(rand() < 0.5 ? { sourceP3: rand() < 0.5 } : {}),
      };
      const audio = { bass: rand(), mid: rand(), treble: rand(), beat: rand() };
      // PreviewEngine's buffer starts zeroed and only these packers write it;
      // the legacy packer never wrote the tail pad (slot 35), the spec writes 0.
      const a = new Float32Array(36);
      const b = new Float32Array(36);
      packLayerUniforms(a, params, audio);
      legacyLayer(b, params as never, audio);
      expect(bytes(a)).toEqual(bytes(b));
    }
  });
});
