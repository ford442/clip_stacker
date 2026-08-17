/**
 * Separable box blur (normalized) for UI soft masks.
 * Radius is integer pixels; kernel width = 2*radius+1.
 */
export function separableBlur(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const r = Math.max(1, radius | 0);
  const tmp = new Float32Array(width * height * 4);
  const out = new Uint8ClampedArray(width * height * 4);
  const kernelSize = r * 2 + 1;
  const inv = 1 / kernelSize;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let k = -r; k <= r; k++) {
        const sx = x + k < 0 ? 0 : x + k > width - 1 ? width - 1 : x + k;
        const i = (y * width + sx) * 4;
        s0 += pixels[i]!;
        s1 += pixels[i + 1]!;
        s2 += pixels[i + 2]!;
        s3 += pixels[i + 3]!;
      }
      const o = (y * width + x) * 4;
      tmp[o] = s0 * inv;
      tmp[o + 1] = s1 * inv;
      tmp[o + 2] = s2 * inv;
      tmp[o + 3] = s3 * inv;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let k = -r; k <= r; k++) {
        const sy = y + k < 0 ? 0 : y + k > height - 1 ? height - 1 : y + k;
        const i = (sy * width + x) * 4;
        s0 += tmp[i]!;
        s1 += tmp[i + 1]!;
        s2 += tmp[i + 2]!;
        s3 += tmp[i + 3]!;
      }
      const o = (y * width + x) * 4;
      out[o] = s0 * inv;
      out[o + 1] = s1 * inv;
      out[o + 2] = s2 * inv;
      out[o + 3] = s3 * inv;
    }
  }
  return out;
}
