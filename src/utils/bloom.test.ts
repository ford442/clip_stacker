import { describe, expect, it } from 'vitest';
import bloomShader from '../webgpu/shaders/bloom.wgsl?raw';
import type { Project } from '../types';
import {
  BLOOM_LINEAR_CLAMP,
  BLOOM_UNIFORM_FLOATS,
  bloomBuffer,
  bloomImage,
  bloomLevelChain,
  downsample13,
  normalizeBloomPass,
  packBloomUniforms,
  planBloom,
  sampleBilinear,
  type BloomSettings,
  type RgbImage,
} from './bloom';
import {
  DEFAULT_BLOOM,
  DEFAULT_FINISHING,
  isBloomActive,
  isFinishingActive,
  normalizeFinishingSettings,
} from './finishing';
import { applyProjectData, serializeProject } from './project';
import { createTestClip } from './project.test.helpers';

const on = (over: Partial<BloomSettings> = {}): BloomSettings => ({
  ...DEFAULT_BLOOM,
  enabled: true,
  amount: 1,
  tint: [1, 1, 1],
  ...over,
});

function image(w: number, h: number, fn: (u: number, v: number) => number): RgbImage {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn((x + 0.5) / w, (y + 0.5) / h);
      data.set([c, c, c], (y * w + x) * 3);
    }
  }
  return { width: w, height: h, data };
}

const at = (img: RgbImage, x: number, y: number, k = 1) => img.data[(y * img.width + x) * 3 + k];

/** Dark frame with a bright disc on the left and a small dot on the right. */
const scene = (w: number, h: number) =>
  image(w, h, (u, v) => {
    if (Math.hypot((u - 0.3) * (w / h), v - 0.5) < 0.1) return 1;
    if (Math.hypot((u - 0.75) * (w / h), v - 0.4) < 0.03) return 1;
    return 0.1;
  });

describe('bloom settings', () => {
  it('is off by default; old projects load it disabled', () => {
    expect(isBloomActive(DEFAULT_BLOOM)).toBe(false);
    expect(isFinishingActive(DEFAULT_FINISHING)).toBe(false);
    expect(isBloomActive(on({ amount: 0 }))).toBe(false);
    expect(isBloomActive(on())).toBe(true);
    expect(normalizeFinishingSettings({ sharpen: DEFAULT_FINISHING.sharpen }).bloom).toEqual(
      DEFAULT_BLOOM,
    );
  });

  it('normalizes untrusted values', () => {
    expect(
      normalizeBloomPass(
        { enabled: true, amount: 3, mode: 'nope' as never, threshold: -1, radius: 9, tint: [5, -1, 'x' as never] },
        DEFAULT_BLOOM,
      ),
    ).toEqual({
      enabled: true,
      amount: 1,
      mode: 'bloom',
      threshold: 0,
      softness: DEFAULT_BLOOM.softness,
      radius: 1,
      tint: [2, 0, 1],
    });
  });

  it('round-trips through project save / load', async () => {
    const sourceClips = [createTestClip('source1', 5)];
    const bloom = on({ amount: 0.6, mode: 'lightWrap', radius: 0.3, tint: [1, 0.8, 0.6] });
    const serialized = serializeProject(sourceClips, [], [], [], { ...DEFAULT_FINISHING, bloom });
    const json = JSON.parse(JSON.stringify(serialized)) as Project;
    const project: Project = {
      clips: [
        {
          id: 'saved',
          title: 'Clip',
          kind: 'video',
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: 'source1.mp4',
        },
      ],
      finishing: json.finishing,
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.finishing.bloom).toEqual(bloom);
    // Grain (and its own halation / bloom) is untouched by the new slot.
    expect(result.finishing.grain).toEqual(DEFAULT_FINISHING.grain);
  });
});

describe('bloom pyramid plan', () => {
  it('uses a prefix of the per-size level chain', () => {
    const chain = bloomLevelChain(1920, 1080);
    expect(chain[0]).toEqual({ width: 960, height: 540 });
    for (const r of [0, 0.25, 0.5, 1]) {
      const plan = planBloom(r, 1920, 1080);
      expect(plan.sizes).toEqual(chain.slice(0, plan.sizes.length));
      expect(plan.deepestWeight).toBeGreaterThan(0);
      expect(plan.deepestWeight).toBeLessThanOrEqual(1);
    }
  });

  it('half the resolution needs one level fewer for the same radius', () => {
    for (const r of [0.2, 0.5, 0.8]) {
      const full = planBloom(r, 1920, 1080);
      const half = planBloom(r, 960, 540);
      expect(half.sizes.length).toBe(full.sizes.length - 1);
      expect(half.sizes.at(-1)).toEqual(full.sizes.at(-1));
      expect(half.deepestWeight).toBeCloseTo(full.deepestWeight, 6);
    }
  });

  it('a bigger radius never shrinks the glow, and tiny frames still plan', () => {
    let prev = 0;
    for (let r = 0; r <= 1.0001; r += 0.05) {
      const p = planBloom(r, 1920, 1080);
      const depth = p.sizes.length - 1 + p.deepestWeight;
      expect(depth).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = depth;
    }
    expect(planBloom(1, 2, 2).sizes).toEqual([{ width: 1, height: 1 }]);
    expect(planBloom(0.5, 1, 1).norm).toBe(1);
  });
});

describe('bloom reference', () => {
  it('a frame below the threshold does not glow', () => {
    const dark = image(96, 54, () => 0.5);
    expect(bloomImage(dark, on({ threshold: 0.7, softness: 0 })).data).toEqual(dark.data);
  });

  it('normalized: a flat field blooms to itself whatever the radius', () => {
    const flat = image(96, 54, () => 0.8);
    for (const radius of [0, 0.5, 1]) {
      const glow = bloomBuffer(flat, on({ threshold: 0, radius }));
      expect(at(glow, 48, 27)).toBeCloseTo(0.8, 4);
      expect(at(glow, 0, 0)).toBeCloseTo(0.8, 4);
    }
  });

  it('glows around highlights, falling off with distance; a bigger radius reaches further', () => {
    const img = scene(192, 108);
    const near = bloomBuffer(img, on({ radius: 0.2 }));
    const far = bloomBuffer(img, on({ radius: 0.8 }));
    const x0 = Math.round(0.3 * 192 + 0.1 * 108 + 4); // just right of the disc
    const x1 = x0 + 16;
    expect(at(near, x0, 54)).toBeGreaterThan(at(near, x1, 54));
    expect(at(far, x1, 54)).toBeGreaterThan(at(near, x1, 54));
    const out = bloomImage(img, on({ radius: 0.4 }));
    expect(at(out, x0, 54)).toBeGreaterThan(at(img, x0, 54));
    // Screen never pushes past white on the display-referred chain.
    expect(Math.max(...out.data)).toBeLessThanOrEqual(1);
  });

  it('Karis weighting keeps a single hot pixel from blowing out the glow', () => {
    // One very hot texel that only the corner group of the 13-tap filter sees.
    const hot = image(64, 64, () => 0);
    hot.data.set([40, 40, 40], (29 * 64 + 29) * 3);
    const karis = downsample13(hot, 0.5, 0.5, true);
    const plain = downsample13(hot, 0.5, 0.5, false);
    expect(plain[1]).toBeGreaterThan(0.25);
    expect(karis[1]).toBeLessThan(plain[1] * 0.5);
    // Scene-linear prefilter is also clamped.
    const glow = bloomBuffer(hot, on({ threshold: 0 }), true);
    expect(Math.max(...glow.data)).toBeLessThan(BLOOM_LINEAR_CLAMP);
  });

  it('tint colours the glow', () => {
    const img = scene(96, 54);
    const warm = bloomImage(img, on({ tint: [1, 0.5, 0.2] }));
    const x = Math.round(0.3 * 96 + 0.1 * 54 + 3);
    expect(at(warm, x, 27, 0)).toBeGreaterThan(at(warm, x, 27, 2));
  });

  it('scene-linear adds light instead of screening', () => {
    const img = scene(96, 54);
    const lin = bloomImage(img, on(), true);
    expect(Math.max(...lin.data)).toBeGreaterThan(1);
  });

  it('light wrap lifts dark pixels beside bright ones and leaves flat areas alone', () => {
    // Dark subject (left) against a bright background (right).
    const img = image(128, 72, (u) => (u < 0.5 ? 0.1 : 0.9));
    const out = bloomImage(img, on({ mode: 'lightWrap', amount: 1, radius: 0.15 }));
    const edge = 63; // last dark column
    expect(at(out, edge, 36)).toBeGreaterThan(at(img, edge, 36) + 0.1);
    expect(at(out, 5, 36)).toBeCloseTo(0.1, 2); // deep inside the subject
    expect(at(out, 120, 36)).toBeCloseTo(0.9, 2); // bright side is not darkened
    const flat = image(64, 36, () => 0.4);
    const wrapped = bloomImage(flat, on({ mode: 'lightWrap' }));
    for (let i = 0; i < wrapped.data.length; i++) {
      expect(wrapped.data[i]).toBeCloseTo(0.4, 4);
    }
  });

  it('half-res preview and full-res export glow alike', () => {
    for (const radius of [0.1, 0.5]) {
      const big = bloomBuffer(scene(320, 180), on({ radius }));
      const small = bloomBuffer(scene(160, 90), on({ radius }));
      let sum = 0;
      let n = 0;
      for (let y = 0; y < 90; y++) {
        for (let x = 0; x < 160; x++) {
          const a = sampleBilinear(big, (x + 0.5) / 160, (y + 0.5) / 90)[1];
          sum += (a - at(small, x, y)) ** 2;
          n++;
        }
      }
      expect(Math.sqrt(sum / n)).toBeLessThan(0.01);
    }
  });
});

describe('bloom.wgsl mirrors bloom.ts', () => {
  it('has the packed uniform layout', () => {
    expect(BLOOM_UNIFORM_FLOATS).toBe(12);
    const body = /struct BloomUniforms \{([\s\S]*?)\n\};/.exec(bloomShader)?.[1] ?? '';
    const fields = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
      .map((l) => l.replace(/,$/, ''));
    expect(fields).toEqual([
      'srcTexel: vec2<f32>',
      'threshold: f32',
      'knee: f32',
      'weight: f32',
      'mode: f32',
      'gain: f32',
      'norm: f32',
      'tint: vec3<f32>',
      '_pad: f32',
    ]);
    expect(Number(/const BLOOM_LINEAR_CLAMP: f32 = ([0-9.]+);/.exec(bloomShader)?.[1])).toBe(
      BLOOM_LINEAR_CLAMP,
    );
  });

  it('light wrap ignores the threshold and does not double the gain', () => {
    const u = packBloomUniforms(on({ mode: 'lightWrap', threshold: 0.9, amount: 0.5 }), 100, 50, 1, 0.2);
    expect(u[2]).toBe(0);
    expect(u[5]).toBe(1);
    expect(u[6]).toBe(0.5);
    expect(u[0]).toBeCloseTo(0.01);
    expect(u[1]).toBeCloseTo(0.02);
  });
});
