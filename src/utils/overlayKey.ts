/**
 * Chroma / luma keying shared by every compositor.
 *
 * Keying used to exist only as an FFmpeg filter (`chromakey` / `lumakey`, see
 * `buildOverlayAlphaFilters` in `overlayBlend.ts`), so a keyed overlay looked
 * right on the Force-FFmpeg export and nowhere else — not in the preview, and
 * not in the default WebGPU + WebCodecs export, which reuses the preview
 * compositor. This module is the one place the key math lives:
 *
 * - {@link keyPixel} is the reference implementation (unit tested).
 * - `preview.wgsl`'s `keyAlpha()` is the same function in WGSL, uniform-driven.
 * - `drawClipLayer` (Canvas2D) calls {@link applyKeyToImageData} for the
 *   non-GPU encoder.
 *
 * All three must agree with FFmpeg so Force-FFmpeg stays a *fallback*, not a
 * different look. Where the maths below looks odd, it is matching FFmpeg.
 */

import type { Clip } from '../types';
import { resolveChromaKey, resolveOverlayBlend } from './overlayBlend';
import { ffmpegColorToRgb01 } from './color';

/** Key mode as packed into the shader uniform. Must match `preview.wgsl`. */
export const KEY_MODE = {
  none: 0,
  chroma: 1,
  luma: 2,
} as const;

export type KeyModeValue = (typeof KEY_MODE)[keyof typeof KEY_MODE];

/**
 * Chroma-plane scale for BT.601 *limited* range (the `yuv420p` planes FFmpeg's
 * `chromakey` actually reads): the U/V planes span 224 of 255 code values, so
 * a distance computed in full-range UV would come out ~14% too large and the
 * inspector's similarity slider would key noticeably more than FFmpeg does.
 * The +128 offset cancels in the difference, so it is not applied at all.
 */
const CHROMA_LIMITED_RANGE_SCALE = 224 / 255;

/** Key uniforms for one layer, in the order `preview.wgsl` reads them. */
export interface LayerKeyUniforms {
  mode: KeyModeValue;
  /** Key colour in linear-ish sRGB 0–1 (as authored, not gamma converted). */
  keyR: number;
  keyG: number;
  keyB: number;
  /** 0–1 — how close a pixel must be to the key before it goes transparent. */
  similarity: number;
  /** 0–1 — width of the soft edge above `similarity`. */
  blend: number;
}

/** Number of uniform floats {@link packKeyUniforms} writes. */
export const KEY_UNIFORM_FLOATS = 6;

/** Nothing keyed — every pixel keeps its source alpha. */
export const NO_KEY: LayerKeyUniforms = {
  mode: KEY_MODE.none,
  keyR: 0,
  keyG: 0,
  keyB: 0,
  similarity: 0,
  blend: 0,
};

/**
 * Key uniforms for a clip, or `null` when the clip is not keyed at all.
 *
 * Only `chroma` and `luma` produce a key. `opaque` / `premultiplied` /
 * `source-alpha` are alpha-channel handling, not keying, and the GPU and
 * Canvas2D compositors already sample source alpha correctly for those.
 */
export function resolveLayerKey(
  clip: Pick<Clip, 'overlayBlend' | 'chromaKey'>,
): LayerKeyUniforms | null {
  const mode = resolveOverlayBlend(clip);
  if (mode !== 'chroma' && mode !== 'luma') return null;

  const key = resolveChromaKey(clip);
  // A colour FFmpeg would reject falls back to the default green plate
  // rather than white, which would key highlights instead of the backdrop.
  const [keyR, keyG, keyB] = ffmpegColorToRgb01(key.color, [0, 1, 0]);
  return {
    mode: mode === 'chroma' ? KEY_MODE.chroma : KEY_MODE.luma,
    keyR,
    keyG,
    keyB,
    similarity: key.similarity,
    blend: key.blend,
  };
}

/**
 * Spread-in `key` entry for a composition layer, or nothing when the clip is
 * unkeyed — an absent key keeps unkeyed layers structurally identical to what
 * they were before keying existed (same shape as `stabMatrixEntry`).
 */
export function layerKeyEntry(
  clip: Pick<Clip, 'overlayBlend' | 'chromaKey'>,
): { key?: LayerKeyUniforms } {
  const key = resolveLayerKey(clip);
  return key ? { key } : {};
}

/** Write `key` into `target` at `offset` in the shader's field order. */
export function packKeyUniforms(
  target: Float32Array,
  offset: number,
  key: LayerKeyUniforms | undefined,
): void {
  const k = key ?? NO_KEY;
  target[offset] = k.mode;
  target[offset + 1] = k.keyR;
  target[offset + 2] = k.keyG;
  target[offset + 3] = k.keyB;
  target[offset + 4] = k.similarity;
  target[offset + 5] = k.blend;
}

/** BT.601 luma of an sRGB 0–1 triple — the `Y` plane FFmpeg's lumakey reads. */
function lumaBt601(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** BT.601 `U` (Cb) with the +0.5 offset dropped; see the scale constant. */
function chromaU(r: number, g: number, b: number): number {
  return (CHROMA_LIMITED_RANGE_SCALE * (b - lumaBt601(r, g, b))) / 1.772;
}

/** BT.601 `V` (Cr) with the +0.5 offset dropped. */
function chromaV(r: number, g: number, b: number): number {
  return (CHROMA_LIMITED_RANGE_SCALE * (r - lumaBt601(r, g, b))) / 1.402;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Alpha multiplier for one pixel under `key`. 0 = fully keyed out, 1 = kept.
 *
 * **Chroma** matches `vf_chromakey.c`: the normalized Euclidean distance
 * between the pixel's and the key colour's `(U, V)`, ramped from `similarity`
 * over `blend`. A zero `blend` is a hard cut, exactly as FFmpeg treats it.
 *
 * **Luma** matches `vf_lumakey.c` as `buildOverlayAlphaFilters` configures it
 * (`threshold=0`, `tolerance=similarity`, `softness=blend`): everything at or
 * below `similarity` luma is keyed out, with a `blend`-wide ramp above it.
 *
 * Inputs and the result are 0–1. This does *not* multiply the source alpha —
 * callers combine the two, which is what the shader does.
 */
export function keyPixel(
  r: number,
  g: number,
  b: number,
  key: LayerKeyUniforms,
): number {
  if (key.mode === KEY_MODE.chroma) {
    const du = chromaU(r, g, b) - chromaU(key.keyR, key.keyG, key.keyB);
    const dv = chromaV(r, g, b) - chromaV(key.keyR, key.keyG, key.keyB);
    const diff = Math.sqrt((du * du + dv * dv) / 2);
    if (key.blend > 0.0001) {
      return clamp01((diff - key.similarity) / key.blend);
    }
    return diff > key.similarity ? 1 : 0;
  }

  if (key.mode === KEY_MODE.luma) {
    const white = clamp01(key.similarity);
    const luma = lumaBt601(r, g, b);
    if (luma <= white) return 0;
    if (key.blend > 0.0001) {
      return clamp01((luma - white) / key.blend);
    }
    return 1;
  }

  return 1;
}

/**
 * Apply `key` to an RGBA `ImageData` buffer in place (Canvas2D export path).
 *
 * The buffer is assumed straight (non-premultiplied) alpha, which is what
 * `getImageData` returns.
 */
export function applyKeyToImageData(
  data: Uint8ClampedArray,
  key: LayerKeyUniforms,
): void {
  if (key.mode === KEY_MODE.none) return;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = keyPixel(
      data[i] / 255,
      data[i + 1] / 255,
      data[i + 2] / 255,
      key,
    );
    if (alpha < 1) data[i + 3] = Math.round(data[i + 3] * alpha);
  }
}
