import type { LumaLevels } from '../types';

/** Rec.709 luma weights (same as Chromashift / WebGPU fundamentals srgbLuminance). */
export const BT709_R = 0.2126;
export const BT709_G = 0.7152;
export const BT709_B = 0.0722;

export const HISTOGRAM_BINS = 256;

/**
 * 256-bin Rec.709 luma histogram from RGBA8.
 * Uses encoded sRGB channel values (not linearized), matching Chromashift.
 */
export function lumaHistogramBt709(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint32Array {
  const bins = new Uint32Array(HISTOGRAM_BINS);
  const count = Math.min(pixels.length, width * height * 4);
  for (let i = 0; i < count; i += 4) {
    const y =
      (pixels[i]! * BT709_R + pixels[i + 1]! * BT709_G + pixels[i + 2]! * BT709_B) / 255;
    const bin = Math.min(HISTOGRAM_BINS - 1, y * HISTOGRAM_BINS) | 0;
    bins[bin]! += 1;
  }
  return bins;
}

export function levelsFromHistogram(bins: Uint32Array, clipPct = 0.005): LumaLevels {
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < bins.length; i++) {
    const n = bins[i] ?? 0;
    total += n;
    weighted += n * i;
  }
  if (total === 0) {
    return { black: 0, white: 255, mean: 0 };
  }
  const low = total * clipPct;
  const high = total * (1 - clipPct);
  let acc = 0;
  let black = 0;
  let white = bins.length - 1;
  let blackSet = false;
  for (let i = 0; i < bins.length; i++) {
    acc += bins[i] ?? 0;
    if (!blackSet && acc >= low) {
      black = i;
      blackSet = true;
    }
    if (acc >= high) {
      white = i;
      break;
    }
  }
  if (white <= black) white = Math.min(bins.length - 1, black + 1);
  return { black, white, mean: weighted / total };
}
