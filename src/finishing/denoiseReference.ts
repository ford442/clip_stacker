/**
 * CPU reference for the spatial stage of `shaders/denoise.wgsl` — every
 * quality mode, mirrored line for line, driven by the same packed uniforms
 * (`packNoiseReductionUniforms`). Tests use it to measure noise removal and
 * edge retention per mode, and the WGSL is checked against it numerically.
 * Temporal blending is not modelled (it is unchanged across modes).
 *
 * Images are RGB in [0, 1], row-major, top row first (texture order).
 */

/** Uniform slot holding the quality mode (see `NOISE_REDUCTION_QUALITY_CODE`). */
export const NR_QUALITY_SLOT = 10;

/**
 * `high`: spatial reach = radius × scale, capped (dense taps — a strided
 * kernel leaves a 2-px checkerboard in flat areas). Cap 4.5 → ≤ 69 taps.
 */
export const NR_HIGH_RADIUS_SCALE = 1.5;
export const NR_HIGH_MAX_REACH = 4.5;
/** `high`: Tukey edge-stop cutoff in luma units at strength 0 … 1. */
export const NR_HIGH_CUTOFF_MIN = 0.05;
export const NR_HIGH_CUTOFF_MAX = 0.3;
/** `nlm`: filtering parameter h in luma units at strength 0 … 1. */
export const NR_NLM_H_MIN = 0.02;
export const NR_NLM_H_MAX = 0.11;
/** `nlm`: search window half-size bounds (window = 2S+1 squared). */
export const NR_NLM_MAX_SEARCH = 3;

export interface RgbImage {
  width: number;
  height: number;
  /** length = width * height * 3 */
  data: Float32Array;
}

type Vec3 = [number, number, number];

const f32 = Math.fround;

function luma(c: Vec3): number {
  return f32(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
}

function rgbToYuv(c: Vec3): Vec3 {
  const y = luma(c);
  return [y, (c[2] - y) * 0.565, (c[0] - y) * 0.713];
}

function yuvToRgb(yuv: Vec3): Vec3 {
  return [
    yuv[0] + 1.403 * yuv[2],
    yuv[0] - 0.344 * yuv[1] - 0.714 * yuv[2],
    yuv[0] + 1.77 * yuv[1],
  ];
}

const clip = (v: number) => Math.min(1, Math.max(0, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Clamp-to-edge texel fetch (WGSL `textureLoad` with clamped coords). */
export function fetchRgb(img: RgbImage, x: number, y: number): Vec3 {
  const cx = Math.min(img.width - 1, Math.max(0, x));
  const cy = Math.min(img.height - 1, Math.max(0, y));
  const i = (cy * img.width + cx) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Tukey biweight: 1 at d = 0, 0 at |d| >= 1 — a hard, smooth edge stop. */
export function tukey(d: number): number {
  const t = Math.min(Math.abs(d), 1);
  const s = 1 - t * t;
  return s * s;
}

/** Legacy `bilateralLuma` (the `standard` mode), sampling texel centres. */
function standardLuma(img: RgbImage, x: number, y: number, u: Float32Array): number {
  const centerY = luma(fetchRgb(img, x, y));
  const radius = Math.min(Math.max(u[2], 0), 4);
  if (radius < 0.01 || u[1] <= 0) return centerY;
  const draftScale = u[6] > 0.5 ? 0.65 : 1;
  const sigmaS = Math.max(0.5, radius) * 0.55 * draftScale;
  const sigmaR = mix(0.04, 0.18, u[1]) * draftScale;
  const twoSigmaS2 = 2 * sigmaS * sigmaS;
  const twoSigmaR2 = 2 * sigmaR * sigmaR;
  let sum = 0;
  let wSum = 0;
  const rMax = Math.ceil(radius);
  for (let dy = -rMax; dy <= rMax; dy++) {
    for (let dx = -rMax; dx <= rMax; dx++) {
      const dist2 = dx * dx + dy * dy;
      if (dist2 > radius * radius + 0.01) continue;
      const sy = luma(fetchRgb(img, x + dx, y + dy));
      const d = sy - centerY;
      const w = Math.exp(-dist2 / twoSigmaS2) * Math.exp(-(d * d) / twoSigmaR2);
      sum += sy * w;
      wSum += w;
    }
  }
  if (wSum <= 1e-6) return centerY;
  return mix(centerY, sum / wSum, clip(u[1]));
}

/**
 * `high`: guided bilateral. The range weight compares each tap with a 3×3
 * sigma-filtered guide (much less noisy than the centre pixel alone, so noise
 * does not lock the filter onto itself) through a Tukey edge stop that gives the far side of an edge exactly zero
 * weight. The reach grows by 1.5× (capped at 4.5 px, ≤ 69 dense taps), and chroma reuses the luma weights, so colour noise is
 * removed without bleeding across luma edges. Returns filtered RGB.
 */
export function highRgb(img: RgbImage, x: number, y: number, u: Float32Array): Vec3 {
  const center = fetchRgb(img, x, y);
  const centerY = luma(center);
  const radius = Math.min(Math.max(u[2], 0), 4);
  const strength = clip(u[1]);
  if (radius < 0.01 || u[1] <= 0) return center;

  const cutoff = mix(NR_HIGH_CUTOFF_MIN, NR_HIGH_CUTOFF_MAX, strength);
  // Guide: a 3×3 sigma filter around the centre (taps within the cutoff of
  // the centre, Tukey-weighted). Less noisy than the centre pixel, so the
  // range test below stops on edges rather than on noise — but, unlike a
  // median, it keeps 1 px lines and texture.
  let gSum = 0;
  let gW = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const v = luma(fetchRgb(img, x + i, y + j));
      const w = tukey((v - centerY) / cutoff);
      gSum += v * w;
      gW += w;
    }
  }
  const guide = gSum / gW;

  const reach = u[6] > 0.5 ? radius : Math.min(radius * NR_HIGH_RADIUS_SCALE, NR_HIGH_MAX_REACH);
  const steps = Math.floor(reach + 1e-4);
  const sigmaS = Math.max(0.5, reach) * 0.5;
  const twoSigmaS2 = 2 * sigmaS * sigmaS;

  const sum: Vec3 = [0, 0, 0];
  let wSum = 0;
  for (let j = -steps; j <= steps; j++) {
    for (let i = -steps; i <= steps; i++) {
      const ox = i;
      const oy = j;
      const dist2 = ox * ox + oy * oy;
      if (dist2 > reach * reach + 0.01) continue;
      const s = fetchRgb(img, x + ox, y + oy);
      const w = Math.exp(-dist2 / twoSigmaS2) * tukey((luma(s) - guide) / cutoff);
      sum[0] += s[0] * w;
      sum[1] += s[1] * w;
      sum[2] += s[2] * w;
      wSum += w;
    }
  }
  if (wSum <= 1e-6) return center;
  return [
    mix(center[0], sum[0] / wSum, strength),
    mix(center[1], sum[1] / wSum, strength),
    mix(center[2], sum[2] / wSum, strength),
  ];
}

/**
 * `nlm`: non-local means. Candidates in a (2S+1)² window are weighted by the
 * similarity of their 3×3 luma patch to the centre's, with Buades' noise
 * offset (`max(d² − 2σ², 0)`, σ = h/2) and the centre weighted like its best
 * neighbour. Patch distances come from one cached (2S+3)² luma block, so the
 * cost is ≤ 81 + 48 texel fetches. Returns filtered RGB.
 */
export function nlmRgb(img: RgbImage, x: number, y: number, u: Float32Array): Vec3 {
  const center = fetchRgb(img, x, y);
  const radius = Math.min(Math.max(u[2], 0), 4);
  const strength = clip(u[1]);
  if (radius < 0.01 || u[1] <= 0) return center;

  const search = Math.min(Math.max(Math.round(radius), 1), NR_NLM_MAX_SEARCH);
  const n = search + 1;
  const side = 2 * n + 1;
  const block: number[] = new Array(side * side);
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      block[(j + n) * side + (i + n)] = luma(fetchRgb(img, x + i, y + j));
    }
  }
  const h = mix(NR_NLM_H_MIN, NR_NLM_H_MAX, strength);
  const invH2 = 1 / (h * h);

  const sum: Vec3 = [0, 0, 0];
  let wSum = 0;
  let wMax = 0;
  for (let j = -search; j <= search; j++) {
    for (let i = -search; i <= search; i++) {
      if (i === 0 && j === 0) continue;
      let d2 = 0;
      for (let pj = -1; pj <= 1; pj++) {
        for (let pi = -1; pi <= 1; pi++) {
          const a = block[(n + pj) * side + (n + pi)];
          const b = block[(n + j + pj) * side + (n + i + pi)];
          d2 += (a - b) * (a - b);
        }
      }
      d2 /= 9;
      const w = Math.exp(-Math.max(d2 * invH2 - 0.5, 0));
      const s = fetchRgb(img, x + i, y + j);
      sum[0] += s[0] * w;
      sum[1] += s[1] * w;
      sum[2] += s[2] * w;
      wSum += w;
      wMax = Math.max(wMax, w);
    }
  }
  const wCenter = wMax > 1e-6 ? wMax : 1;
  sum[0] += center[0] * wCenter;
  sum[1] += center[1] * wCenter;
  sum[2] += center[2] * wCenter;
  wSum += wCenter;
  return [
    mix(center[0], sum[0] / wSum, strength),
    mix(center[1], sum[1] / wSum, strength),
    mix(center[2], sum[2] / wSum, strength),
  ];
}

/** One output pixel of the spatial stage (no temporal), as `fs_main` writes it. */
export function denoisePixel(img: RgbImage, x: number, y: number, u: Float32Array): Vec3 {
  const src = fetchRgb(img, x, y);
  const amount = clip(u[0]);
  if (amount <= 0) return src;
  const yuv = rgbToYuv(src);
  const quality = u[NR_QUALITY_SLOT];
  const lumaOnly = u[5] > 0.5;
  let result: Vec3;
  if (quality > 0.5) {
    // Filter in RGB with luma-guided weights; Luma only adds just the luma
    // change, so source chroma is kept exactly (no lossy YUV round trip).
    const f = quality > 1.5 ? nlmRgb(img, x, y, u) : highRgb(img, x, y, u);
    const dy = luma(f) - yuv[0];
    result = (lumaOnly ? [src[0] + dy, src[1] + dy, src[2] + dy] : f).map(clip) as Vec3;
  } else {
    const fy = standardLuma(img, x, y, u);
    if (lumaOnly) {
      result = yuvToRgb([fy, yuv[1], yuv[2]]).map(clip) as Vec3;
    } else {
      const nb = rgbToYuv(fetchRgb(img, x + 1, y + 1));
      const k = u[1] * 0.35;
      result = yuvToRgb([fy, mix(yuv[1], nb[1], k), mix(yuv[2], nb[2], k)]).map(clip) as Vec3;
    }
  }
  return [mix(src[0], result[0], amount), mix(src[1], result[1], amount), mix(src[2], result[2], amount)];
}

export function denoiseImage(img: RgbImage, u: Float32Array): RgbImage {
  const out = new Float32Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = denoisePixel(img, x, y, u);
      const i = (y * img.width + x) * 3;
      out[i] = p[0];
      out[i + 1] = p[1];
      out[i + 2] = p[2];
    }
  }
  return { width: img.width, height: img.height, data: out };
}
