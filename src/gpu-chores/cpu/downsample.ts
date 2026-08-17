/**
 * Bilinear downsample of RGBA8. Documented golden vs Canvas2D `drawImage`
 * with `imageSmoothingEnabled = true` (bilinear / low quality). Photographic
 * downscales typically stay within MAE < 4 per channel; exact pixel match is
 * not guaranteed because browsers may use mipmaps or higher-quality filters.
 */
export function downsample2d(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8ClampedArray {
  const dw = Math.max(1, outWidth | 0);
  const dh = Math.max(1, outHeight | 0);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xScale = width / dw;
  const yScale = height / dh;
  const maxX = width - 1;
  const maxY = height - 1;

  for (let y = 0; y < dh; y++) {
    const srcY = (y + 0.5) * yScale - 0.5;
    const y0 = srcY < 0 ? 0 : srcY > maxY ? maxY : srcY;
    const y1 = Math.min(maxY, Math.floor(y0) + 1);
    const fy = y0 - Math.floor(y0);
    const iy0 = Math.floor(y0);
    for (let x = 0; x < dw; x++) {
      const srcX = (x + 0.5) * xScale - 0.5;
      const x0 = srcX < 0 ? 0 : srcX > maxX ? maxX : srcX;
      const x1 = Math.min(maxX, Math.floor(x0) + 1);
      const fx = x0 - Math.floor(x0);
      const ix0 = Math.floor(x0);
      const dest = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = pixels[(iy0 * width + ix0) * 4 + c]!;
        const p10 = pixels[(iy0 * width + x1) * 4 + c]!;
        const p01 = pixels[(y1 * width + ix0) * 4 + c]!;
        const p11 = pixels[(y1 * width + x1) * 4 + c]!;
        const top = p00 + (p10 - p00) * fx;
        const bot = p01 + (p11 - p01) * fx;
        out[dest + c] = top + (bot - top) * fy;
      }
    }
  }
  return out;
}

/** Mean absolute error per channel (0–255) between two RGBA buffers. */
export function rgbaMeanAbsError(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return sum / n;
}
