import { describe, expect, it } from 'vitest';
import caShader from '../webgpu/shaders/chromaticAberration.wgsl?raw';
import {
  CA_MAX_SHIFT,
  CA_SPECTRAL_SIGMA,
  CA_SPECTRAL_TAPS,
  CHROMATIC_ABERRATION_UNIFORM_FLOATS,
  chromaticAberrationOffsets,
  chromaticAberrationPixel,
  normalizeChromaticAberrationPass,
  packChromaticAberrationUniforms,
  type ChromaticAberrationSettings,
  type RgbImage,
} from './chromaticAberration';
import {
  DEFAULT_CHROMATIC_ABERRATION,
  DEFAULT_FINISHING,
  isChromaticAberrationActive,
  isFinishingActive,
  normalizeFinishingSettings,
} from './finishing';

const on = (over: Partial<ChromaticAberrationSettings> = {}): ChromaticAberrationSettings => ({
  ...DEFAULT_CHROMATIC_ABERRATION,
  enabled: true,
  amount: 1,
  ...over,
});

function image(w: number, h: number, fn: (x: number, y: number) => [number, number, number]) {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 3);
  }
  return { width: w, height: h, data } satisfies RgbImage;
}

describe('chromatic aberration settings', () => {
  it('is off by default and when amount is 0', () => {
    expect(isChromaticAberrationActive(DEFAULT_CHROMATIC_ABERRATION)).toBe(false);
    expect(isFinishingActive(DEFAULT_FINISHING)).toBe(false);
    expect(isChromaticAberrationActive(on({ amount: 0 }))).toBe(false);
    expect(isChromaticAberrationActive(on())).toBe(true);
    expect(isFinishingActive({ chromaticAberration: on() })).toBe(true);
  });

  it('projects saved before the pass load it disabled', () => {
    const normalized = normalizeFinishingSettings({ sharpen: DEFAULT_FINISHING.sharpen });
    expect(normalized.chromaticAberration).toEqual(DEFAULT_CHROMATIC_ABERRATION);
    expect(isFinishingActive(normalized)).toBe(false);
  });

  it('normalizes untrusted values and wraps the angle', () => {
    const n = normalizeChromaticAberrationPass(
      { enabled: true, amount: 3, radial: -1, angle: 270, spectral: 'yes' as never },
      DEFAULT_CHROMATIC_ABERRATION,
    );
    expect(n).toEqual({ enabled: true, amount: 1, radial: 0, angle: -90, spectral: true });
    expect(normalizeChromaticAberrationPass({ enabled: true, angle: 180 }, DEFAULT_CHROMATIC_ABERRATION).angle).toBe(-180);
  });

  it('packs into 8 floats', () => {
    const u = packChromaticAberrationUniforms(on({ spectral: false }), 1920, 1080);
    expect(u).toHaveLength(CHROMATIC_ABERRATION_UNIFORM_FLOATS);
    expect(u[0]).toBeCloseTo(2 * CA_MAX_SHIFT);
    expect(u[3]).toBe(0);
    // Disabled → zero offsets, which the shader treats as a pass-through.
    expect(
      Array.from(packChromaticAberrationUniforms(on({ enabled: false }), 64, 64).slice(0, 3)),
    ).toEqual([0, 0, 0]);
  });
});

describe('chromatic aberration offsets', () => {
  it('radial: zero at the centre, `shift` of the height at the short-edge midpoint', () => {
    const o = chromaticAberrationOffsets(on({ radial: 1 }), 1920, 1080);
    expect(o.dirX).toBe(0);
    expect(o.dirY).toBe(0);
    // Offset at uv (0.5, 1): radialK * 0.5 in UV = CA_MAX_SHIFT of the height.
    expect(o.radialK * 0.5).toBeCloseTo(CA_MAX_SHIFT);
  });

  it('directional: the shift is `shift` of the height along the angle, in pixels', () => {
    for (const angle of [0, 90, 45, -135]) {
      const w = 1920;
      const h = 1080;
      const o = chromaticAberrationOffsets(on({ radial: 0, angle }), w, h);
      const px = Math.hypot(o.dirX * w, o.dirY * h);
      expect(px).toBeCloseTo(CA_MAX_SHIFT * h, 6);
      const a = (Math.atan2(o.dirY * h, o.dirX * w) * 180) / Math.PI;
      expect(((a - angle + 540) % 360) - 180).toBeCloseTo(0, 6);
    }
  });

  it('scales with the frame, so a smaller preview shows the same fringe', () => {
    const big = chromaticAberrationOffsets(on({ radial: 0.5, angle: 30 }), 1920, 1080);
    const small = chromaticAberrationOffsets(on({ radial: 0.5, angle: 30 }), 960, 540);
    expect(small).toEqual(big);
  });
});

describe('chromatic aberration reference', () => {
  const W = 64;
  const H = 36;

  it('leaves a flat frame untouched (spectral weights sum to 1 per channel)', () => {
    const flat = image(W, H, () => [0.3, 0.5, 0.7]);
    for (const spectral of [true, false]) {
      const u = packChromaticAberrationUniforms(on({ radial: 0.6, angle: 20, spectral }), W, H);
      for (const [x, y] of [[0, 0], [31, 17], [63, 35]]) {
        const p = chromaticAberrationPixel(flat, x, y, u);
        expect(p[0]).toBeCloseTo(0.3, 6);
        expect(p[1]).toBeCloseTo(0.5, 6);
        expect(p[2]).toBeCloseTo(0.7, 6);
      }
    }
  });

  it('radial: red fringes outward and blue inward at an edge right of centre; green stays put', () => {
    // White bar on black covering x in [36, 52) — right of centre.
    const img = image(W, H, (x) => (x >= 36 && x < 52 ? [1, 1, 1] : [0, 0, 0]));
    const u = packChromaticAberrationUniforms(on({ radial: 1, spectral: false }), W, H);
    const outside = chromaticAberrationPixel(img, 52, 18, u); // just past the right edge
    const inside = chromaticAberrationPixel(img, 51, 18, u); // last white column
    expect(outside[0]).toBeGreaterThan(0.1); // red spills outward
    expect(outside[1]).toBe(0);
    expect(outside[2]).toBe(0);
    expect(inside[2]).toBeLessThan(0.9); // blue pulled inward
    expect(inside[1]).toBe(1);
    // The centre pixel of a centred feature does not move.
    const centred = image(W, H, (x, y) => (x === 32 && y === 18 ? [1, 1, 1] : [0, 0, 0]));
    const c = chromaticAberrationPixel(centred, 32, 18, u);
    expect(c[1]).toBe(1);
  });

  it('spectral spreads the fringe instead of a hard colour copy', () => {
    const img = image(W, H, (x) => (x >= 36 && x < 52 ? [1, 1, 1] : [0, 0, 0]));
    const hard = packChromaticAberrationUniforms(on({ radial: 1, spectral: false }), W, H);
    const soft = packChromaticAberrationUniforms(on({ radial: 1, spectral: true }), W, H);
    const h = chromaticAberrationPixel(img, 52, 18, hard);
    const s = chromaticAberrationPixel(img, 52, 18, soft);
    expect(s[0]).toBeGreaterThan(0);
    expect(s[0]).toBeLessThan(h[0]);
    expect(s[1]).toBeGreaterThan(0); // a little green bleeds too: a soft fringe
  });
});

describe('chromaticAberration.wgsl mirrors chromaticAberration.ts', () => {
  it('shares the spectral constants and the uniform layout', () => {
    expect(/const CA_SPECTRAL_TAPS: i32 = (\d+);/.exec(caShader)?.[1]).toBe(
      String(CA_SPECTRAL_TAPS),
    );
    expect(Number(/const CA_SPECTRAL_SIGMA: f32 = ([0-9.]+);/.exec(caShader)?.[1])).toBe(
      CA_SPECTRAL_SIGMA,
    );
    const body = /struct ChromaticAberrationUniforms \{([\s\S]*?)\n\};/.exec(caShader)?.[1] ?? '';
    const fields = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
      .map((l) => /^(\w+)\s*:\s*f32,$/.exec(l)?.[1]);
    expect(fields).toHaveLength(CHROMATIC_ABERRATION_UNIFORM_FLOATS);
    expect(fields.slice(0, 4)).toEqual(['radialK', 'dirX', 'dirY', 'spectral']);
  });
});
