/**
 * CPU reference for `shaders/sharpen.wgsl` — every mode, mirrored line for
 * line and driven by the packed uniforms (`packSharpenUniforms`). Tests use it
 * to measure halo, texture gain and noise amplification per mode, and the
 * WGSL is checked against it numerically.
 *
 * Images are RGB in [0, 1], row-major, top row first (texture order).
 */

/** Uniform slot holding the mode (see `SHARPEN_MODE_CODE`). */
export const SHARPEN_MODE_SLOT = 6;

/**
 * Range sigma (luma) of the edge-aware blur: steps well above it stay in the
 * base and are not sharpened. 0.08 removes halos on edges down to ~0.15
 * contrast while keeping most of the gain on texture.
 */
export const SHARPEN_EDGE_SIGMA = 0.08;
/** Multi-scale: the medium band's sigma is the fine sigma × this. */
export const SHARPEN_MS_SIGMA_RATIO = 2.5;
/** Multi-scale: weight of the medium band in the sharpening detail. */
export const SHARPEN_MS_MEDIUM_GAIN = 0.75;
/** Multi-scale: midtone detail gain on the medium band. */
export const SHARPEN_MS_MIDTONE_GAIN = 1.5;
/** Window half-size of the multi-scale kernel (7×7). */
export const SHARPEN_MS_WINDOW = 3;

export interface RgbImage {
  width: number;
  height: number;
  /** length = width * height * 3 */
  data: Float32Array;
}

type Vec3 = [number, number, number];

const f32 = Math.fround;
const clip = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clip((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function luma(c: Vec3): number {
  return f32(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
}

/** Clamp-to-edge texel fetch (WGSL `textureLoad` with clamped coords). */
export function fetchRgb(img: RgbImage, x: number, y: number): Vec3 {
  const cx = Math.min(img.width - 1, Math.max(0, x));
  const cy = Math.min(img.height - 1, Math.max(0, y));
  const i = (cy * img.width + cx) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function midtoneWeight(y: number): number {
  return smoothstep(0.15, 0.3, y) * (1 - smoothstep(0.7, 0.85, y));
}

/** Legacy `classic` unsharp (luma, hard threshold, lossy YUV round trip). */
function classicPixel(img: RgbImage, x: number, y: number, u: Float32Array): Vec3 {
  const src = fetchRgb(img, x, y);
  const amount = clip(u[0]);
  const midtone = clip(u[3]);
  if (amount <= 0 && midtone <= 0) return src;
  const yc = luma(src);
  const uCh = (src[2] - yc) * 0.565;
  const vCh = (src[0] - yc) * 0.713;

  const radius = Math.min(Math.max(u[1], 0.5), 3);
  const sigma = Math.max(radius * 0.5, 0.2);
  const twoSigma2 = 2 * sigma * sigma;
  const limit = Math.ceil(radius);
  let sum = 0;
  let wSum = 0;
  for (let dy = -limit; dy <= limit; dy++) {
    for (let dx = -limit; dx <= limit; dx++) {
      const w = Math.exp(-(dx * dx + dy * dy) / twoSigma2);
      sum += luma(fetchRgb(img, x + dx, y + dy)) * w;
      wSum += w;
    }
  }
  const detail = yc - sum / wSum;
  const gate = Math.abs(detail) > clip(u[2]) ? 1 : 0;
  let outY = yc + amount * detail * gate + midtone * midtoneWeight(yc) * detail;
  outY = clip(outY);
  return [
    clip(outY + 1.403 * vCh),
    clip(outY - 0.344 * uCh - 0.714 * vCh),
    clip(outY + 1.77 * uCh),
  ];
}

/**
 * `edge` (mode 1) and `multiscale` (mode 2).
 *
 * - Detail is split in two. *Texture* detail comes from a range-weighted
 *   blur (Gaussian on the luma difference from the centre, sigma
 *   `SHARPEN_EDGE_SIGMA`), so strong edges stay in its base. *Edge* detail is
 *   the rest of the classic unsharp detail; it may steepen a transition but
 *   the result is clamped to the [min, max] of the source luma inside the
 *   kernel window, so edges get crisper without ever overshooting into a
 *   halo or ringing. Texture detail is not clamped (a texture peak is its
 *   own local maximum, so clamping it would cap texture gain).
 * - The threshold is a soft gate (`smoothstep(thr, 2·thr, |detail|)`), so
 *   noise just above the threshold is not boosted at full strength.
 * - Multi-scale adds a medium band (fine blur − a 2.5× wider blur) for
 *   micro-contrast; midtone detail drives that band instead of the fine one,
 *   so it lifts local contrast without amplifying grain or noise.
 * - The luma change is added to RGB, so chroma is kept exactly.
 */
function edgeAwarePixel(img: RgbImage, x: number, y: number, u: Float32Array): Vec3 {
  const src = fetchRgb(img, x, y);
  const amount = clip(u[0]);
  const midtone = clip(u[3]);
  if (amount <= 0 && midtone <= 0) return src;
  const multi = u[SHARPEN_MODE_SLOT] > 1.5;
  const yc = luma(src);

  const radius = Math.min(Math.max(u[1], 0.5), 3);
  const sigmaF = Math.max(radius * 0.5, 0.2);
  const sigmaM = sigmaF * SHARPEN_MS_SIGMA_RATIO;
  const twoF = 2 * sigmaF * sigmaF;
  const twoM = 2 * sigmaM * sigmaM;
  const twoR = 2 * SHARPEN_EDGE_SIGMA * SHARPEN_EDGE_SIGMA;
  const limit = multi ? SHARPEN_MS_WINDOW : Math.ceil(radius);

  let sumG = 0;
  let wG = 0;
  let sumF = 0;
  let wF = 0;
  let sumM = 0;
  let wM = 0;
  let mn = yc;
  let mx = yc;
  for (let dy = -limit; dy <= limit; dy++) {
    for (let dx = -limit; dx <= limit; dx++) {
      const s = luma(fetchRgb(img, x + dx, y + dy));
      const d = s - yc;
      const rw = Math.exp(-(d * d) / twoR);
      const r2 = dx * dx + dy * dy;
      const g = Math.exp(-r2 / twoF);
      sumG += s * g;
      wG += g;
      const w1 = g * rw;
      sumF += s * w1;
      wF += w1;
      const w2 = Math.exp(-r2 / twoM) * rw;
      sumM += s * w2;
      wM += w2;
      mn = Math.min(mn, s);
      mx = Math.max(mx, s);
    }
  }
  const baseF = sumF / wF;
  const fine = yc - baseF;
  const medium = multi ? baseF - sumM / wM : 0;
  const detail = fine + SHARPEN_MS_MEDIUM_GAIN * medium;

  const edge = yc - sumG / wG - fine;

  // Soft threshold: nothing below `thr` (like classic's hard gate), full
  // strength from 2·thr, so detail just above it — mostly noise — is not
  // boosted at full strength. Texture and edge detail are gated separately.
  const thr = clip(u[2]);
  const softGate = (v: number) =>
    thr <= 1e-6 ? 1 : smoothstep(thr, 2 * thr, Math.abs(v));
  const textured = yc + amount * detail * softGate(detail);
  const sharpened = Math.min(
    Math.max(textured + amount * edge * softGate(edge + fine), Math.min(mn, textured)),
    Math.max(mx, textured),
  );
  const outY =
    sharpened +
    midtone * midtoneWeight(yc) * (multi ? SHARPEN_MS_MIDTONE_GAIN * medium : fine);

  const dl = outY - yc;
  return [clip(src[0] + dl), clip(src[1] + dl), clip(src[2] + dl)];
}

/** One output pixel of `fs_main` (display-referred). */
export function sharpenPixel(img: RgbImage, x: number, y: number, u: Float32Array): Vec3 {
  return u[SHARPEN_MODE_SLOT] > 0.5
    ? edgeAwarePixel(img, x, y, u)
    : classicPixel(img, x, y, u);
}

export function sharpenImage(img: RgbImage, u: Float32Array): RgbImage {
  const out = new Float32Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = sharpenPixel(img, x, y, u);
      const i = (y * img.width + x) * 3;
      out[i] = p[0];
      out[i + 1] = p[1];
      out[i + 2] = p[2];
    }
  }
  return { width: img.width, height: img.height, data: out };
}
