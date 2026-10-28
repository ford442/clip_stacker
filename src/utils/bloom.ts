/**
 * Bloom / glow / light wrap — a standalone finishing pass after chromatic
 * aberration, before grain (grain stays last). Independent of the grain
 * pass's own halation / bloom, which are unchanged.
 *
 * Pipeline (the "dual filter" pyramid used by modern engines):
 *   1. prefilter: full frame → half-res level 0 with a 13-tap downsample whose
 *      five 2×2 groups are Karis-weighted (1 / (1 + luma)), so a single hot
 *      pixel cannot flicker the whole glow; then a soft-knee threshold.
 *   2. downsample: level k → k+1, the same 13-tap filter (no Karis).
 *   3. upsample: a 9-tap tent of level k+1 added onto level k, from the
 *      deepest level up. The deepest level is added with a fractional weight,
 *      so the radius slider is continuous.
 *   4. composite: a tent of level 0 at full res, normalized by the number of
 *      levels (a flat field blooms to itself, whatever the radius), tinted
 *      and added — `screen` on the 8-bit chain so highlights roll off, plain
 *      add in the scene-linear working space.
 *
 * The radius is a fraction of the frame height and the level count is
 * chosen from it per resolution, so the half-res preview canvas and a full
 * export glow over the same part of the picture.
 *
 * `lightWrap` mode blurs the whole frame (no threshold) and pulls that light
 * over pixels that are darker than their surround — soft edges where a
 * subject meets a bright background, e.g. a keyed overlay.
 *
 * WebGPU only. The FFmpeg path skips it (`RenderPlan.ffmpegFinishingGaps`);
 * Canvas2D does not apply finishing. `bloomImage` is the CPU reference the
 * WGSL mirrors.
 */

import { clamp, clamp01, finiteOr } from './math';

export type BloomMode = 'bloom' | 'lightWrap';

export interface BloomSettings {
  enabled: boolean;
  /** Glow strength 0 (bypass) → 1. */
  amount?: number;
  mode: BloomMode;
  /** Brightness (max channel) where bloom starts, 0 … 1. Ignored by light wrap. */
  threshold: number;
  /** Soft knee as a fraction of the threshold, 0 (hard) … 1 (very soft). */
  softness: number;
  /** Spread 0 … 1 → 1 % … 25 % of the frame height. */
  radius: number;
  /** Linear RGB multiplier for the glow (white = neutral). */
  tint: [number, number, number];
}

export const BLOOM_UNIFORM_FLOATS = 12;
/** Glow gain at amount 1. */
export const BLOOM_GAIN = 4;
export const BLOOM_SPREAD_MIN = 0.01;
export const BLOOM_SPREAD_MAX = 0.25;
/** Most pyramid levels (half res … 1/512 res). */
export const BLOOM_MAX_LEVELS = 9;
/** Scene-linear prefilter clamp (bounds fireflies from very hot pixels). */
export const BLOOM_LINEAR_CLAMP = 64;
export const BLOOM_AMOUNT_RECOMMENDED = 0.4;

export const DEFAULT_BLOOM_PARAMS = {
  mode: 'bloom' as BloomMode,
  threshold: 0.7,
  softness: 0.5,
  radius: 0.4,
  tint: [1, 1, 1] as [number, number, number],
};

export function isBloomMode(v: unknown): v is BloomMode {
  return v === 'bloom' || v === 'lightWrap';
}

export function isBloomNeutral(pass: BloomSettings | undefined): boolean {
  if (!pass?.enabled) return true;
  return finiteOr(pass.amount, 0) <= 1e-6;
}

export function normalizeBloomPass(
  raw: Partial<BloomSettings> | undefined,
  defaults: BloomSettings,
): BloomSettings {
  if (!raw || typeof raw !== 'object') return { ...defaults, tint: [...defaults.tint] };
  const d = DEFAULT_BLOOM_PARAMS;
  const rawTint = Array.isArray(raw.tint) ? raw.tint : defaults.tint ?? d.tint;
  return {
    enabled: Boolean(raw.enabled),
    amount: Number.isFinite(raw.amount)
      ? clamp01(raw.amount as number)
      : (defaults.amount ?? BLOOM_AMOUNT_RECOMMENDED),
    mode: isBloomMode(raw.mode) ? raw.mode : (defaults.mode ?? d.mode),
    threshold: clamp01(finiteOr(raw.threshold, defaults.threshold ?? d.threshold)),
    softness: clamp01(finiteOr(raw.softness, defaults.softness ?? d.softness)),
    radius: clamp01(finiteOr(raw.radius, defaults.radius ?? d.radius)),
    tint: [0, 1, 2].map((i) => clamp(finiteOr(rawTint[i], 1), 0, 2)) as [number, number, number],
  };
}

// ---------------------------------------------------------------------------
// Pyramid plan

export interface BloomLevelSize {
  width: number;
  height: number;
}

export interface BloomPlan {
  /** Level sizes, index 0 = half res; the deepest is `sizes.length - 1`. */
  sizes: BloomLevelSize[];
  /** Weight of the deepest level (0 … 1] — keeps the radius continuous. */
  deepestWeight: number;
  /** 1 / (levels at full weight + deepestWeight): a flat field blooms to itself. */
  norm: number;
}

export function bloomSpread(radius: number): number {
  return BLOOM_SPREAD_MIN + (BLOOM_SPREAD_MAX - BLOOM_SPREAD_MIN) * clamp01(radius);
}

/**
 * Every level a frame can have (half res down to ~2 px). A plan uses a
 * prefix of it, so the GPU pass allocates this once per frame size and a
 * radius change never reallocates.
 */
export function bloomLevelChain(width: number, height: number): BloomLevelSize[] {
  const all: BloomLevelSize[] = [];
  let w = Math.max(1, Math.floor(width / 2));
  let h = Math.max(1, Math.floor(height / 2));
  while (all.length < BLOOM_MAX_LEVELS) {
    all.push({ width: w, height: h });
    if (w < 4 || h < 4) break;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return all;
}

/**
 * Levels for a frame. Level k's texels are 2^(k+1) frame pixels, so the depth
 * follows log2 of the spread in pixels; at half the resolution every level
 * moves up one index and the glow covers the same part of the picture.
 */
export function planBloom(radius: number, width: number, height: number): BloomPlan {
  const all = bloomLevelChain(width, height);
  const deepestPossible = all.length - 1;
  const spreadPx = Math.max(1, bloomSpread(radius) * Math.max(1, height));
  // +1: the deepest level is index L + 1 (weighted by the fraction).
  const depth = clamp(Math.log2(spreadPx) - 2, 0, Math.max(0, deepestPossible - 1) + 1);
  let full = Math.floor(depth);
  let frac = depth - full;
  if (full + 1 > deepestPossible) {
    full = Math.max(0, deepestPossible - 1);
    frac = deepestPossible === 0 ? 0 : 1;
  }
  if (frac < 1e-3) {
    // A zero-weight deepest level adds nothing; drop it.
    if (full === 0) {
      return { sizes: all.slice(0, 1), deepestWeight: 1, norm: 1 };
    }
    full -= 1;
    frac = 1;
  }
  const count = deepestPossible === 0 ? 1 : full + 2;
  const deepestWeight = deepestPossible === 0 ? 1 : frac;
  const fullLevels = deepestPossible === 0 ? 0 : full + 1;
  return {
    sizes: all.slice(0, count),
    deepestWeight,
    norm: 1 / (fullLevels + deepestWeight),
  };
}

/**
 * Pack one draw's uniforms (WGSL `BloomUniforms`, 3 × vec4):
 *   [0..1] source texel size, [2] threshold, [3] knee
 *   [4] upsample weight, [5] mode (0 bloom / 1 light wrap), [6] gain, [7] norm
 *   [8..10] tint, [11] pad
 */
export function packBloomUniforms(
  pass: BloomSettings,
  srcWidth: number,
  srcHeight: number,
  weight: number,
  norm: number,
  out: Float32Array = new Float32Array(BLOOM_UNIFORM_FLOATS),
): Float32Array {
  const wrap = pass.mode === 'lightWrap';
  const threshold = wrap ? 0 : clamp01(finiteOr(pass.threshold, DEFAULT_BLOOM_PARAMS.threshold));
  const softness = clamp01(finiteOr(pass.softness, DEFAULT_BLOOM_PARAMS.softness));
  out[0] = 1 / Math.max(1, srcWidth);
  out[1] = 1 / Math.max(1, srcHeight);
  out[2] = threshold;
  out[3] = threshold * softness;
  out[4] = weight;
  out[5] = wrap ? 1 : 0;
  out[6] = (pass.enabled ? clamp01(finiteOr(pass.amount, 0)) : 0) * (wrap ? 1 : BLOOM_GAIN);
  out[7] = norm;
  const tint = pass.tint ?? DEFAULT_BLOOM_PARAMS.tint;
  out[8] = clamp(finiteOr(tint[0], 1), 0, 2);
  out[9] = clamp(finiteOr(tint[1], 1), 0, 2);
  out[10] = clamp(finiteOr(tint[2], 1), 0, 2);
  out[11] = 0;
  return out;
}

// ---------------------------------------------------------------------------
// CPU reference (mirrors shaders/bloom.wgsl; bilinear, clamp-to-edge)

export interface RgbImage {
  width: number;
  height: number;
  /** length = width * height * 3, row-major, top row first. */
  data: Float32Array;
}

type Vec3 = [number, number, number];

const luma = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function sampleBilinear(img: RgbImage, u: number, v: number): Vec3 {
  const x = u * img.width - 0.5;
  const y = v * img.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number, k: number) => {
    const cx = Math.min(img.width - 1, Math.max(0, xx));
    const cy = Math.min(img.height - 1, Math.max(0, yy));
    return img.data[(cy * img.width + cx) * 3 + k];
  };
  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = at(x0, y0, k) + (at(x0 + 1, y0, k) - at(x0, y0, k)) * fx;
    const b = at(x0, y0 + 1, k) + (at(x0 + 1, y0 + 1, k) - at(x0, y0 + 1, k)) * fx;
    out[k] = a + (b - a) * fy;
  }
  return out;
}

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** 13-tap downsample (COD: Advanced Warfare), optionally Karis-weighted. */
export function downsample13(src: RgbImage, u: number, v: number, karis: boolean): Vec3 {
  const tx = 1 / src.width;
  const ty = 1 / src.height;
  const s = (dx: number, dy: number) => sampleBilinear(src, u + dx * tx, v + dy * ty);
  const a = s(-2, -2), b = s(0, -2), c = s(2, -2);
  const d = s(-1, -1), e = s(1, -1);
  const f = s(-2, 0), g = s(0, 0), h = s(2, 0);
  const i = s(-1, 1), j = s(1, 1);
  const k = s(-2, 2), l = s(0, 2), m = s(2, 2);
  const groups: [Vec3, number][] = [
    [scale(add(add(add(d, e), i), j), 0.25), 0.5],
    [scale(add(add(add(a, b), f), g), 0.25), 0.125],
    [scale(add(add(add(b, c), g), h), 0.25), 0.125],
    [scale(add(add(add(f, g), k), l), 0.25), 0.125],
    [scale(add(add(add(g, h), l), m), 0.25), 0.125],
  ];
  let sum: Vec3 = [0, 0, 0];
  let wSum = 0;
  for (const [avg, w0] of groups) {
    const w = karis ? w0 / (1 + luma(avg)) : w0;
    sum = add(sum, avg, w);
    wSum += w;
  }
  return scale(sum, 1 / wSum);
}

/** Soft-knee threshold on the max channel (Karis / Unity). */
export function softThreshold(c: Vec3, threshold: number, knee: number): Vec3 {
  if (threshold <= 0) return c;
  const br = Math.max(c[0], c[1], c[2]);
  let rq = clamp(br - threshold + knee, 0, 2 * knee);
  rq = (rq * rq) / (4 * knee + 1e-5);
  const contrib = Math.max(rq, br - threshold) / Math.max(br, 1e-5);
  return scale(c, contrib);
}

/** 9-tap tent at UV over `src` texels. */
export function tent9(src: RgbImage, u: number, v: number): Vec3 {
  const tx = 1 / src.width;
  const ty = 1 / src.height;
  let sum: Vec3 = [0, 0, 0];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
      sum = add(sum, sampleBilinear(src, u + dx * tx, v + dy * ty), w / 16);
    }
  }
  return sum;
}

function render(width: number, height: number, fn: (u: number, v: number) => Vec3): RgbImage {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = fn((x + 0.5) / width, (y + 0.5) / height);
      data.set(c, (y * width + x) * 3);
    }
  }
  return { width, height, data };
}

/** The blurred, normalized glow (before tint / gain) at full resolution. */
export function bloomBuffer(img: RgbImage, pass: BloomSettings, sceneLinear = false): RgbImage {
  const plan = planBloom(pass.radius, img.width, img.height);
  const u0 = packBloomUniforms(pass, img.width, img.height, 1, plan.norm);
  const levels: RgbImage[] = [];
  levels.push(
    render(plan.sizes[0].width, plan.sizes[0].height, (u, v) => {
      const c = softThreshold(downsample13(img, u, v, true), u0[2], u0[3]);
      const cap = sceneLinear ? BLOOM_LINEAR_CLAMP : 1;
      return [Math.min(c[0], cap), Math.min(c[1], cap), Math.min(c[2], cap)];
    }),
  );
  for (let k = 1; k < plan.sizes.length; k++) {
    const src = levels[k - 1];
    levels.push(render(plan.sizes[k].width, plan.sizes[k].height, (u, v) => downsample13(src, u, v, false)));
  }
  for (let k = plan.sizes.length - 2; k >= 0; k--) {
    const w = k === plan.sizes.length - 2 ? plan.deepestWeight : 1;
    const up = levels[k + 1];
    const dst = levels[k];
    levels[k] = render(dst.width, dst.height, (u, v) => {
      const i = (Math.floor(v * dst.height) * dst.width + Math.floor(u * dst.width)) * 3;
      const base: Vec3 = [dst.data[i], dst.data[i + 1], dst.data[i + 2]];
      return add(base, tent9(up, u, v), w);
    });
  }
  const top = levels[0];
  return render(img.width, img.height, (u, v) => scale(tent9(top, u, v), plan.norm));
}

/** Full pass on an image (display-referred unless `sceneLinear`). */
export function bloomImage(img: RgbImage, pass: BloomSettings, sceneLinear = false): RgbImage {
  if (isBloomNeutral(pass)) return { ...img, data: img.data.slice() };
  const glow = bloomBuffer(img, pass, sceneLinear);
  const u = packBloomUniforms(pass, img.width, img.height, 1, 1);
  const out = new Float32Array(img.data.length);
  for (let p = 0; p < img.width * img.height; p++) {
    const src: Vec3 = [img.data[p * 3], img.data[p * 3 + 1], img.data[p * 3 + 2]];
    const b: Vec3 = [glow.data[p * 3], glow.data[p * 3 + 1], glow.data[p * 3 + 2]];
    out.set(compositeBloom(src, b, u, sceneLinear), p * 3);
  }
  return { width: img.width, height: img.height, data: out };
}

/** Mirrors WGSL `composite`. `b` is the normalized glow. */
export function compositeBloom(
  src: Vec3,
  b: Vec3,
  u: ArrayLike<number>,
  sceneLinear: boolean,
): Vec3 {
  const tint: Vec3 = [u[8], u[9], u[10]];
  const gain = u[6];
  if (u[5] > 0.5) {
    // Light wrap: pull the surrounding light over pixels darker than it.
    const lb = luma(b);
    const ls = luma(src);
    const w = clamp01((lb - ls) / Math.max(lb, 1e-4)) * gain;
    const wrapped: Vec3 = [b[0] * tint[0], b[1] * tint[1], b[2] * tint[2]];
    const o: Vec3 = [
      src[0] + (wrapped[0] - src[0]) * w,
      src[1] + (wrapped[1] - src[1]) * w,
      src[2] + (wrapped[2] - src[2]) * w,
    ];
    return sceneLinear ? o : (o.map(clamp01) as Vec3);
  }
  const g: Vec3 = [b[0] * tint[0] * gain, b[1] * tint[1] * gain, b[2] * tint[2] * gain];
  if (sceneLinear) return add(src, g);
  return [0, 1, 2].map((k) => 1 - (1 - clamp01(src[k])) * (1 - clamp01(g[k]))) as Vec3;
}
