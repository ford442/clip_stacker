/**
 * Image comparison for the render regression harness: PSNR over RGB and a
 * mean SSIM over 8×8 luma windows. Pure (ImageData-shaped input), so the
 * thresholds are unit tested without a browser.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface ImageComparison {
  /** Peak signal-to-noise ratio over RGB, dB (Infinity when identical). */
  psnr: number;
  /** Mean structural similarity of BT.709 luma, 0…1. */
  ssim: number;
}

function assertSameSize(a: RgbaImage, b: RgbaImage): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}

export function psnr(a: RgbaImage, b: RgbaImage): number {
  assertSameSize(a, b);
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n * 4; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c]! - b.data[i + c]!;
      sum += d * d;
    }
  }
  const mse = sum / (n * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function luma(img: RgbaImage): Float64Array {
  const out = new Float64Array(img.width * img.height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
  }
  return out;
}

const SSIM_WINDOW = 8;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

export function ssim(a: RgbaImage, b: RgbaImage): number {
  assertSameSize(a, b);
  const la = luma(a);
  const lb = luma(b);
  const { width, height } = a;
  let total = 0;
  let windows = 0;
  for (let y0 = 0; y0 + SSIM_WINDOW <= height; y0 += SSIM_WINDOW) {
    for (let x0 = 0; x0 + SSIM_WINDOW <= width; x0 += SSIM_WINDOW) {
      let ma = 0;
      let mb = 0;
      for (let y = y0; y < y0 + SSIM_WINDOW; y++) {
        for (let x = x0; x < x0 + SSIM_WINDOW; x++) {
          ma += la[y * width + x]!;
          mb += lb[y * width + x]!;
        }
      }
      const count = SSIM_WINDOW * SSIM_WINDOW;
      ma /= count;
      mb /= count;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let y = y0; y < y0 + SSIM_WINDOW; y++) {
        for (let x = x0; x < x0 + SSIM_WINDOW; x++) {
          const da = la[y * width + x]! - ma;
          const db = lb[y * width + x]! - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= count - 1;
      vb /= count - 1;
      cov /= count - 1;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }
  return windows === 0 ? 1 : total / windows;
}

export function compareImages(a: RgbaImage, b: RgbaImage): ImageComparison {
  return { psnr: psnr(a, b), ssim: ssim(a, b) };
}

/** Mean RGB of the image — a cheap "is this frame black / blank" probe. */
export function meanRgb(img: RgbaImage): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n * 4; i += 4) {
    r += img.data[i]!;
    g += img.data[i + 1]!;
    b += img.data[i + 2]!;
  }
  return [r / n, g / n, b / n];
}
