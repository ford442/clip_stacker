/**
 * Chromatic aberration (lens colour fringe) — finishing pass after sharpen,
 * before grain. WebGPU only (`shaders/chromaticAberration.wgsl`); FFmpeg has
 * no radial per-channel scale, so the FFmpeg path reports it in
 * `RenderPlan.ffmpegFinishingGaps` instead of approximating it, and Canvas2D
 * does not apply finishing.
 *
 * Model: red and blue are resampled at offsets ±o(uv) while green stays put.
 *   o(uv) = radialK · (uv − 0.5) + directional offset
 * `radialK` scales red up and blue down about the frame centre (lateral CA:
 * zero at the centre, growing toward the edges); the directional part is a
 * uniform shift along `angle`. Offsets are fractions of the frame height, so
 * the preview canvas and a larger export show the same fringe.
 *
 * `spectral` replaces the three hard channel copies with a 7-tap spread along
 * the offset, weighted per channel (red toward +o, green at 0, blue toward
 * −o), which reads like a real lens fringe rather than a misregistered print.
 * Each channel's weights sum to 1, so flat areas are untouched.
 */

import { clamp01, finiteOr } from './math';

export const CHROMATIC_ABERRATION_UNIFORM_FLOATS = 8;

/** Fringe width at amount 1, as a fraction of frame height (≈ 8.6 px at 1080p). */
export const CA_MAX_SHIFT = 0.008;
/** Spectral spread: taps along the offset, and each channel's Gaussian width in t. */
export const CA_SPECTRAL_TAPS = 7;
export const CA_SPECTRAL_SIGMA = 0.45;

export const CA_AMOUNT_RECOMMENDED = 0.35;

export interface ChromaticAberrationSettings {
  enabled: boolean;
  /** Fringe strength 0 (bypass) → 1 (≈ 0.8 % of frame height). */
  amount?: number;
  /** 1 = radial lens CA (grows toward the edges), 0 = uniform directional shift. */
  radial: number;
  /** Direction of the directional component, degrees clockwise from +x. */
  angle: number;
  /** Soft spectral fringe (7 taps) instead of three hard channel copies. */
  spectral: boolean;
}

export const DEFAULT_CHROMATIC_ABERRATION_PARAMS = {
  radial: 1,
  angle: 0,
  spectral: true,
};

export function isChromaticAberrationNeutral(
  pass: ChromaticAberrationSettings | undefined,
): boolean {
  if (!pass?.enabled) return true;
  return finiteOr(pass.amount, 0) <= 1e-6;
}

/** Per-frame constants the shader needs, in UV units of the target. */
export interface ChromaticAberrationOffsets {
  /** Radial coefficient: o += radialK · (uv − 0.5). */
  radialK: number;
  /** Directional offset in UV. */
  dirX: number;
  dirY: number;
  spectral: boolean;
}

export function chromaticAberrationOffsets(
  pass: ChromaticAberrationSettings,
  width: number,
  height: number,
): ChromaticAberrationOffsets {
  const d = DEFAULT_CHROMATIC_ABERRATION_PARAMS;
  const amount = pass.enabled ? clamp01(finiteOr(pass.amount, 0)) : 0;
  const shift = amount * CA_MAX_SHIFT;
  const radial = clamp01(finiteOr(pass.radial, d.radial));
  const angle = (finiteOr(pass.angle, d.angle) * Math.PI) / 180;
  const aspect = width > 0 && height > 0 ? width / height : 1;
  // Radial: a channel scaled by (1 ± radialK) about the centre moves the
  // short-edge midpoint (0.5 of the height from the centre) by `shift`.
  const radialK = 2 * shift * radial;
  const directional = shift * (1 - radial);
  return {
    radialK,
    dirX: (directional * Math.cos(angle)) / aspect,
    dirY: directional * Math.sin(angle),
    spectral: pass.spectral !== false,
  };
}

/**
 * Pack into WGSL `ChromaticAberrationUniforms` (2 × vec4):
 *   [0] radialK, dirX, dirY, spectral
 *   [1] pad × 4
 */
export function packChromaticAberrationUniforms(
  pass: ChromaticAberrationSettings,
  width: number,
  height: number,
  out: Float32Array = new Float32Array(CHROMATIC_ABERRATION_UNIFORM_FLOATS),
): Float32Array {
  if (out.length < CHROMATIC_ABERRATION_UNIFORM_FLOATS) {
    throw new Error(
      `Chromatic aberration uniform buffer needs ${CHROMATIC_ABERRATION_UNIFORM_FLOATS} floats`,
    );
  }
  const o = chromaticAberrationOffsets(pass, width, height);
  out.fill(0);
  out[0] = o.radialK;
  out[1] = o.dirX;
  out[2] = o.dirY;
  out[3] = o.spectral ? 1 : 0;
  return out;
}

export function normalizeChromaticAberrationPass(
  raw: Partial<ChromaticAberrationSettings> | undefined,
  defaults: ChromaticAberrationSettings,
): ChromaticAberrationSettings {
  if (!raw || typeof raw !== 'object') return { ...defaults };
  const d = DEFAULT_CHROMATIC_ABERRATION_PARAMS;
  const angle = finiteOr(raw.angle, defaults.angle ?? d.angle);
  return {
    enabled: Boolean(raw.enabled),
    amount: Number.isFinite(raw.amount)
      ? clamp01(raw.amount as number)
      : (defaults.amount ?? CA_AMOUNT_RECOMMENDED),
    radial: clamp01(finiteOr(raw.radial, defaults.radial ?? d.radial)),
    // Wrap into [-180, 180) so the slider can always show it.
    angle: ((((angle + 180) % 360) + 360) % 360) - 180,
    spectral: typeof raw.spectral === 'boolean' ? raw.spectral : (defaults.spectral ?? d.spectral),
  };
}

// ---------------------------------------------------------------------------
// Spectral weights + CPU reference (mirrored by the WGSL; tests use both).

/** Tap position t ∈ [−1, 1] for tap i of CA_SPECTRAL_TAPS. */
export function spectralTap(i: number): number {
  return -1 + (2 * i) / (CA_SPECTRAL_TAPS - 1);
}

/** Un-normalized weights of tap t for (r, g, b): red peaks at +1, green 0, blue −1. */
export function spectralWeights(t: number): [number, number, number] {
  const twoS2 = 2 * CA_SPECTRAL_SIGMA * CA_SPECTRAL_SIGMA;
  return [
    Math.exp(-((t - 1) * (t - 1)) / twoS2),
    Math.exp(-(t * t) / twoS2),
    Math.exp(-((t + 1) * (t + 1)) / twoS2),
  ];
}

export interface RgbImage {
  width: number;
  height: number;
  /** length = width * height * 3, row-major, top row first. */
  data: Float32Array;
}

/** Mirror-repeat texel index (the pass's sampler mode): -1 → 0, W → W − 1. */
function mirrorIndex(i: number, size: number): number {
  const period = 2 * size;
  const m = ((i % period) + period) % period;
  return m < size ? m : period - 1 - m;
}

/**
 * Bilinear, mirror-repeat sample at UV (texel centres at (i + 0.5) / size).
 * Taps near the frame edge land outside it; mirroring continues real content,
 * where clamp-to-edge would smear the border pixel into a coloured stripe.
 */
export function sampleBilinear(img: RgbImage, u: number, v: number): [number, number, number] {
  const x = u * img.width - 0.5;
  const y = v * img.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number, k: number) =>
    img.data[(mirrorIndex(yy, img.height) * img.width + mirrorIndex(xx, img.width)) * 3 + k];
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = at(x0, y0, k) + (at(x0 + 1, y0, k) - at(x0, y0, k)) * fx;
    const b = at(x0, y0 + 1, k) + (at(x0 + 1, y0 + 1, k) - at(x0, y0 + 1, k)) * fx;
    out[k] = a + (b - a) * fy;
  }
  return out;
}

/** One output pixel of `fs_main`, from packed uniforms. */
export function chromaticAberrationPixel(
  img: RgbImage,
  x: number,
  y: number,
  u: Float32Array,
): [number, number, number] {
  const uvx = (x + 0.5) / img.width;
  const uvy = (y + 0.5) / img.height;
  const ox = u[0] * (uvx - 0.5) + u[1];
  const oy = u[0] * (uvy - 0.5) + u[2];
  const src = sampleBilinear(img, uvx, uvy);
  if (Math.abs(ox) + Math.abs(oy) < 1e-7) return src;
  if (u[3] < 0.5) {
    return [
      sampleBilinear(img, uvx - ox, uvy - oy)[0],
      src[1],
      sampleBilinear(img, uvx + ox, uvy + oy)[2],
    ];
  }
  const acc = [0, 0, 0];
  const wSum = [0, 0, 0];
  for (let i = 0; i < CA_SPECTRAL_TAPS; i++) {
    const t = spectralTap(i);
    const s = sampleBilinear(img, uvx - t * ox, uvy - t * oy);
    const w = spectralWeights(t);
    for (let k = 0; k < 3; k++) {
      acc[k] += s[k] * w[k];
      wSum[k] += w[k];
    }
  }
  return [acc[0] / wSum[0], acc[1] / wSum[1], acc[2] / wSum[2]];
}
