import { describe, expect, it } from 'vitest';
import { compareImages, meanRgb, psnr, ssim, type RgbaImage } from './imageMetrics';

function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const ramp = image(32, 16, (x, y) => [x * 8, y * 16, 128]);

describe('imageMetrics', () => {
  it('scores identical images as perfect', () => {
    expect(compareImages(ramp, ramp)).toEqual({ psnr: Infinity, ssim: 1 });
  });

  it('matches the PSNR formula for a uniform error', () => {
    const shifted = image(32, 16, (x, y) => [x * 8 + 4, y * 16 + 4, 132]);
    // MSE 16 → 10·log10(255² / 16)
    expect(psnr(ramp, shifted)).toBeCloseTo(10 * Math.log10((255 * 255) / 16), 6);
  });

  it('drops SSIM for structural change but not for a small brightness offset', () => {
    const brighter = image(32, 16, (x, y) => [x * 8 + 2, y * 16 + 2, 130]);
    const flipped = image(32, 16, (x, y) => [(31 - x) * 8, (15 - y) * 16, 128]);
    expect(ssim(ramp, brighter)).toBeGreaterThan(0.99);
    expect(ssim(ramp, flipped)).toBeLessThan(0.5);
  });

  it('refuses images of different sizes', () => {
    expect(() => psnr(ramp, image(16, 16, () => [0, 0, 0]))).toThrow(/size mismatch/);
  });

  it('reports the mean colour', () => {
    expect(meanRgb(image(4, 4, () => [10, 20, 30]))).toEqual([10, 20, 30]);
  });
});
