import { BT709_B, BT709_G, BT709_R } from './lumaHistogram';

/** Vectorscope bin grid edge length (128² CbCr cells). */
export const VECTORSCOPE_SIZE = 128;

/** Rec.709 chroma denominators: Cb = (B − Y) / 2(1 − Kb), Cr = (R − Y) / 2(1 − Kr). */
const CB_SCALE = 2 * (1 - BT709_B);
const CR_SCALE = 2 * (1 - BT709_R);

/**
 * CbCr scatter histogram from RGBA8 — the CPU golden for `vectorscope_uv`.
 *
 * Uses encoded sRGB channel values (not linearized), matching
 * `lumaHistogramBt709` so the waveform and the vectorscope describe the same
 * numbers a colourist reads off the composed frame. Cb/Cr land in [−0.5, 0.5]
 * and map to `size` bins each; the returned grid is row-major with Cr on rows
 * (index = cr * size + cb), so a neutral grey frame lands in the centre cell.
 */
export function vectorscopeUv(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  size: number = VECTORSCOPE_SIZE,
): Uint32Array {
  const bins = new Uint32Array(size * size);
  const count = Math.min(pixels.length, width * height * 4);
  for (let i = 0; i < count; i += 4) {
    const r = pixels[i]! / 255;
    const g = pixels[i + 1]! / 255;
    const b = pixels[i + 2]! / 255;
    const y = r * BT709_R + g * BT709_G + b * BT709_B;
    const cb = (b - y) / CB_SCALE + 0.5;
    const cr = (r - y) / CR_SCALE + 0.5;
    const u = clampBin(cb * size, size);
    const v = clampBin(cr * size, size);
    bins[v * size + u]! += 1;
  }
  return bins;
}

function clampBin(value: number, size: number): number {
  if (!(value > 0)) return 0;
  const bin = value | 0;
  return bin >= size ? size - 1 : bin;
}

/** Index of the most populated CbCr cell, as `{ u, v, count }` (for tests/debug). */
export function vectorscopePeak(
  bins: Uint32Array,
  size: number = VECTORSCOPE_SIZE,
): { u: number; v: number; count: number } {
  let best = 0;
  let index = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i]! > best) {
      best = bins[i]!;
      index = i;
    }
  }
  return { u: index % size, v: Math.floor(index / size), count: best };
}
