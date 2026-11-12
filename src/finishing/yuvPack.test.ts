import { describe, expect, it } from 'vitest';
import yuvShader from '../webgpu/shaders/yuvPack.wgsl?raw';
import {
  BT2020_NCL,
  BT709,
  YUV_PACK_MODE_ID,
  chromaOf,
  chromaSiteRgb,
  i420Layout,
  limitedChroma,
  limitedLuma,
  lumaOf,
  packYuvReference,
} from './yuvPack';
import { nitsToPq } from './colorManagement';

function solid(width: number, height: number, rgb: [number, number, number]): Float32Array {
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) out.set([...rgb, 1], i * 4);
  return out;
}

describe('i420Layout', () => {
  it('packs Y, U, V tightly with 16-bit samples for I420P10', () => {
    const layout = i420Layout(1920, 1080, 'i420p10-bt2020');
    expect(layout.chromaWidth).toBe(960);
    expect(layout.chromaHeight).toBe(540);
    expect(layout.planes[0]).toEqual({ offset: 0, stride: 3840 });
    expect(layout.planes[1]).toEqual({ offset: 1920 * 1080 * 2, stride: 1920 });
    expect(layout.planes[2]).toEqual({ offset: (1920 * 1080 + 960 * 540) * 2, stride: 1920 });
    expect(layout.dataBytes).toBe(1920 * 1080 * 3);
    expect(layout.bufferBytes).toBe(layout.dataBytes);
  });

  it('rounds odd sizes up to whole chroma samples and the buffer to whole words', () => {
    const layout = i420Layout(5, 3, 'i420-bt709');
    expect(layout.chromaWidth).toBe(3);
    expect(layout.chromaHeight).toBe(2);
    expect(layout.totalSamples).toBe(15 + 12);
    expect(layout.dataBytes).toBe(27);
    expect(layout.bufferBytes).toBe(28);
  });

  it('rejects an empty frame', () => {
    expect(() => i420Layout(0, 10, 'i420-bt709')).toThrow();
  });
});

describe('limited-range codes', () => {
  it('maps black / white / zero chroma to 64 / 940 / 512 at 10 bits', () => {
    expect(limitedLuma(0, 10)).toBe(64);
    expect(limitedLuma(1, 10)).toBe(940);
    expect(limitedChroma(0, 10)).toBe(512);
    expect(limitedChroma(-0.5, 10)).toBe(64);
    expect(limitedChroma(0.5, 10)).toBe(960);
  });

  it('maps them to 16 / 235 / 128 at 8 bits', () => {
    expect(limitedLuma(0, 8)).toBe(16);
    expect(limitedLuma(1, 8)).toBe(235);
    expect(limitedChroma(0, 8)).toBe(128);
  });

  it('clamps out-of-range input', () => {
    expect(limitedLuma(-1, 10)).toBe(64);
    expect(limitedLuma(2, 10)).toBe(940);
    expect(limitedChroma(9, 8)).toBe(240);
  });
});

describe('BT.2020 NCL / BT.709 matrices', () => {
  it('give unit luma and zero chroma for neutral colours', () => {
    for (const m of [BT2020_NCL, BT709]) {
      expect(lumaOf(1, 1, 1, m)).toBeCloseTo(1, 12);
      const [cb, cr] = chromaOf(0.4, 0.4, 0.4, m);
      expect(cb).toBeCloseTo(0, 12);
      expect(cr).toBeCloseTo(0, 12);
    }
  });

  it('puts pure blue / red at the chroma extremes', () => {
    expect(chromaOf(0, 0, 1, BT2020_NCL)[0]).toBeCloseTo(0.5, 12);
    expect(chromaOf(1, 0, 0, BT2020_NCL)[1]).toBeCloseTo(0.5, 12);
  });
});

describe('packYuvReference', () => {
  it('packs a solid colour into constant planes', () => {
    const rgb: [number, number, number] = [0.6, 0.3, 0.2];
    const out = packYuvReference(solid(4, 2, rgb), 4, 2, 'i420p10-bt2020');
    expect(out).toBeInstanceOf(Uint16Array);
    const y = limitedLuma(lumaOf(...rgb, BT2020_NCL), 10);
    const [cb, cr] = chromaOf(...rgb, BT2020_NCL);
    expect(Array.from(out.subarray(0, 8))).toEqual(new Array(8).fill(y));
    expect(Array.from(out.subarray(8, 10))).toEqual([limitedChroma(cb, 10), limitedChroma(cb, 10)]);
    expect(Array.from(out.subarray(10, 12))).toEqual([limitedChroma(cr, 10), limitedChroma(cr, 10)]);
  });

  it('keeps more than 600 luma codes on a PQ signal ramp', () => {
    // One column per step from 0 to 1000 nits' PQ code: 8-bit RGBA could
    // carry at most ~190 of these after the limited-range squeeze.
    const width = 1920;
    const top = nitsToPq(1000);
    const rgba = new Float32Array(width * 4);
    for (let x = 0; x < width; x++) {
      const v = (top * x) / (width - 1);
      rgba.set([v, v, v, 1], x * 4);
    }
    const out = packYuvReference(rgba, width, 1, 'i420p10-bt2020');
    const codes = new Set(out.subarray(0, width));
    expect(codes.size).toBeGreaterThan(600);
  });

  it('sites chroma on the even column with a [1 2 1] filter and averages two rows', () => {
    const width = 4;
    const height = 2;
    const rgba = new Float32Array(width * height * 4);
    // Column 1 bright in both rows; column 0 / 2 dark.
    for (let y = 0; y < height; y++) rgba.set([1, 1, 1, 1], (y * width + 1) * 4);
    const px = (x: number, y: number) => {
      const cx = Math.min(width - 1, Math.max(0, x));
      const cy = Math.min(height - 1, Math.max(0, y));
      const i = (cy * width + cx) * 4;
      return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!] as const;
    };
    // Chroma site 0 = column 0 (taps −1→0, 0, 1): 0.25 from column 1.
    expect(chromaSiteRgb(px, 0, 0)[0]).toBeCloseTo(0.25, 12);
    // Chroma site 1 = column 2 (taps 1, 2, 3): 0.25 from column 1.
    expect(chromaSiteRgb(px, 1, 0)[0]).toBeCloseTo(0.25, 12);
  });

  it('packs 8-bit BT.709 for the SDR mode', () => {
    const out = packYuvReference(solid(2, 2, [1, 1, 1]), 2, 2, 'i420-bt709');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([235, 235, 235, 235, 128, 128]);
  });
});

describe('yuvPack.wgsl', () => {
  it('uses the same matrix constants as the reference', () => {
    const num = (name: string) => {
      const match = new RegExp(`const ${name}: f32 = ([0-9.]+);`).exec(yuvShader);
      return match ? Number(match[1]) : NaN;
    };
    expect(num('KR_2020')).toBe(BT2020_NCL.kr);
    expect(num('KB_2020')).toBe(BT2020_NCL.kb);
    expect(num('KR_709')).toBe(BT709.kr);
    expect(num('KB_709')).toBe(BT709.kb);
  });

  it('agrees with the mode ids and the limited-range scale', () => {
    expect(YUV_PACK_MODE_ID['i420p10-bt2020']).toBe(0);
    expect(YUV_PACK_MODE_ID['i420-bt709']).toBe(1);
    expect(yuvShader).toContain('219.0 * clamp(y, 0.0, 1.0) + 16.0');
    expect(yuvShader).toContain('224.0 * clamp(c, -0.5, 0.5) + 128.0');
    // Chroma filter: [1 2 1] / 4 horizontally × ½ per row.
    expect(yuvShader).toContain('rgbAt(x - 1, y + dy) * 0.125');
    expect(yuvShader).toContain('rgbAt(x, y + dy) * 0.25');
    expect(yuvShader).toContain('rgbAt(x + 1, y + dy) * 0.125');
    // The 2D dispatch stride matches yuvPackDispatchSize.
    expect(yuvShader).toContain('gid.y * 65535u * 64u');
  });
});
