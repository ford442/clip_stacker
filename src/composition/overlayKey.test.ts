import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  KEY_MODE,
  NO_KEY,
  applyKeyToImageData,
  keyPixel,
  layerKeyEntry,
  packKeyUniforms,
  resolveLayerKey,
} from './overlayKey';

function clip(overrides: Partial<Clip>): Clip {
  return {
    id: 'clip-1',
    kind: 'video',
    title: 'clip',
    ...overrides,
  } as Clip;
}

const GREEN_KEY = {
  mode: KEY_MODE.chroma,
  keyR: 0,
  keyG: 1,
  keyB: 0,
  similarity: 0.3,
  blend: 0,
} as const;

describe('resolveLayerKey', () => {
  it('returns nothing for the alpha-handling modes', () => {
    for (const mode of ['opaque', 'premultiplied', 'source-alpha'] as const) {
      expect(resolveLayerKey(clip({ overlayBlend: mode }))).toBeNull();
    }
    // Default (no overlayBlend at all) is source-alpha.
    expect(resolveLayerKey(clip({}))).toBeNull();
    expect(layerKeyEntry(clip({}))).toEqual({});
  });

  it('resolves chroma with the clip key and the shared defaults', () => {
    const key = resolveLayerKey(
      clip({
        overlayBlend: 'chroma',
        chromaKey: { color: '#00FF00', similarity: 0.4, blend: 0.2 },
      }),
    );
    expect(key).toEqual({
      mode: KEY_MODE.chroma,
      keyR: 0,
      keyG: 1,
      keyB: 0,
      similarity: 0.4,
      blend: 0.2,
    });
  });

  it('falls back to the default green plate for an unparseable colour', () => {
    const key = resolveLayerKey(
      clip({
        overlayBlend: 'chroma',
        chromaKey: { color: 'not-a-colour', similarity: 0.3, blend: 0 },
      }),
    );
    expect([key?.keyR, key?.keyG, key?.keyB]).toEqual([0, 1, 0]);
  });

  it('resolves luma', () => {
    const key = resolveLayerKey(clip({ overlayBlend: 'luma' }));
    expect(key?.mode).toBe(KEY_MODE.luma);
  });
});

describe('keyPixel — chroma', () => {
  it('keys out the key colour itself', () => {
    // The fixture pixel from the issue: pure green against a green key.
    expect(keyPixel(0, 1, 0, GREEN_KEY)).toBe(0);
  });

  it('keeps a colour far from the key', () => {
    expect(keyPixel(1, 0, 0, GREEN_KEY)).toBe(1);
    expect(keyPixel(0, 0, 1, GREEN_KEY)).toBe(1);
  });

  it('keeps greys, which sit at the same UV as any other neutral', () => {
    // Luma differences must not key — that is what separates chroma from luma.
    expect(keyPixel(0.5, 0.5, 0.5, GREEN_KEY)).toBe(1);
    expect(keyPixel(0, 0, 0, GREEN_KEY)).toBe(1);
  });

  it('is a hard cut when blend is zero', () => {
    const near = keyPixel(0.1, 0.9, 0.1, GREEN_KEY);
    expect(near === 0 || near === 1).toBe(true);
  });

  it('ramps across the blend window instead of cutting', () => {
    const soft = { ...GREEN_KEY, similarity: 0.1, blend: 0.5 };
    const alphas = [
      keyPixel(0, 1, 0, soft),
      keyPixel(0.4, 0.8, 0.4, soft),
      keyPixel(1, 0, 0, soft),
    ];
    expect(alphas[0]).toBe(0);
    expect(alphas[1]).toBeGreaterThan(0);
    expect(alphas[1]).toBeLessThan(1);
    // A blend this wide ramps well past red's UV distance, so red is nearly —
    // but, as in FFmpeg, not exactly — opaque.
    expect(alphas[2]).toBeGreaterThan(alphas[1]);
    expect(alphas[2]).toBeGreaterThan(0.9);
  });

  it('widens what it keys as similarity grows', () => {
    const olive = [0.35, 0.6, 0.15] as const;
    const tight = keyPixel(...olive, { ...GREEN_KEY, similarity: 0.05 });
    const loose = keyPixel(...olive, { ...GREEN_KEY, similarity: 0.9 });
    expect(tight).toBe(1);
    expect(loose).toBe(0);
  });
});

describe('keyPixel — luma', () => {
  const lumaKey = {
    mode: KEY_MODE.luma,
    keyR: 0,
    keyG: 0,
    keyB: 0,
    similarity: 0.25,
    blend: 0,
  } as const;

  it('keys out everything at or below the tolerance', () => {
    expect(keyPixel(0, 0, 0, lumaKey)).toBe(0);
    expect(keyPixel(0.2, 0.2, 0.2, lumaKey)).toBe(0);
  });

  it('keeps everything above it', () => {
    expect(keyPixel(1, 1, 1, lumaKey)).toBe(1);
    expect(keyPixel(0.5, 0.5, 0.5, lumaKey)).toBe(1);
  });

  it('ramps over the softness window', () => {
    const soft = { ...lumaKey, similarity: 0.2, blend: 0.4 };
    const alpha = keyPixel(0.4, 0.4, 0.4, soft);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
  });
});

describe('keyPixel — none', () => {
  it('keeps every pixel', () => {
    expect(keyPixel(0, 1, 0, NO_KEY)).toBe(1);
    expect(keyPixel(0.5, 0.5, 0.5, NO_KEY)).toBe(1);
  });
});

describe('packKeyUniforms', () => {
  it('writes the six floats in shader order', () => {
    const target = new Float32Array(10).fill(-1);
    packKeyUniforms(target, 2, {
      mode: KEY_MODE.luma,
      keyR: 0.25,
      keyG: 0.5,
      keyB: 0.75,
      similarity: 0.3,
      blend: 0.1,
    });
    expect(Array.from(target.slice(2, 8))).toEqual([
      2, 0.25, 0.5, 0.75, 0.30000001192092896, 0.10000000149011612,
    ]);
    // Neighbours untouched.
    expect(target[1]).toBe(-1);
    expect(target[8]).toBe(-1);
  });

  it('writes the no-key defaults for an absent key', () => {
    const target = new Float32Array(6).fill(-1);
    packKeyUniforms(target, 0, undefined);
    expect(Array.from(target)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('applyKeyToImageData', () => {
  it('zeroes alpha on the keyed pixels and leaves the rest alone', () => {
    // [green, red] — green is the key colour, red is far from it.
    const data = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255]);
    applyKeyToImageData(data, GREEN_KEY);
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
  });

  it('is a no-op when nothing is keyed', () => {
    const data = new Uint8ClampedArray([0, 255, 0, 255]);
    applyKeyToImageData(data, NO_KEY);
    expect(Array.from(data)).toEqual([0, 255, 0, 255]);
  });

  it('scales the existing alpha rather than replacing it', () => {
    const soft = { ...GREEN_KEY, similarity: 0.1, blend: 0.5 };
    const data = new Uint8ClampedArray([102, 204, 102, 128]);
    applyKeyToImageData(data, soft);
    expect(data[3]).toBeGreaterThan(0);
    expect(data[3]).toBeLessThan(128);
  });
});
