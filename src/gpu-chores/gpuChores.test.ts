import { afterEach, describe, expect, it } from 'vitest';
import { GPU_MIN_PIXELS, selectBackend } from './breakEven';
import { lumaHistogramBt709, levelsFromHistogram } from './cpu/lumaHistogram';
import { downsample2d } from './cpu/downsample';
import { separableBlur } from './cpu/separableBlur';
import { adoptGpuDevice, __resetGpuChoresDeviceForTests } from './device';
import {
  gpuComputeAvailable,
  isGpuComputeKillSwitchEnabled,
  __resetGpuChoreDiagnosticsForTests,
  __setGpuComputeKillSwitchForTests,
} from './diagnostics';
import {
  __resetPreviewWorkerChoresForTests,
  setPreviewWorkerChoresRunner,
} from './previewWorkerBridge';
import { bitmapDimensions } from './rasterize';
import { runJob } from './runJob';
import { analyzeImportedStillPixels } from './stillImport';

function solidRgba(w: number, h: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
  return px;
}

describe('lumaHistogramBt709', () => {
  it('bins black and white Rec.709 extrema', () => {
    const black = lumaHistogramBt709(solidRgba(2, 2, 0, 0, 0), 2, 2);
    expect(black[0]).toBe(4);
    expect(black.reduce((a, b) => a + b, 0)).toBe(4);

    const white = lumaHistogramBt709(solidRgba(1, 1, 255, 255, 255), 1, 1);
    expect(white[255]).toBe(1);
  });

  it('matches Chromashift Rec.709 weights for pure red', () => {
    const bins = lumaHistogramBt709(solidRgba(1, 1, 255, 0, 0), 1, 1);
    const expected = Math.min(255, (0.2126 * 256) | 0);
    expect(bins[expected]).toBe(1);
  });

  it('derives black/white/mean from a two-tone image', () => {
    const px = new Uint8ClampedArray(8);
    px.set([0, 0, 0, 255, 255, 255, 255, 255]);
    const levels = levelsFromHistogram(lumaHistogramBt709(px, 2, 1), 0);
    expect(levels.black).toBe(0);
    expect(levels.white).toBe(255);
    expect(levels.mean).toBeCloseTo(127.5, 5);
  });
});

describe('downsample2d bilinear', () => {
  it('averages a 2×2 checker into a 1×1 (pixel-center sample)', () => {
    const px = new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 255,
    ]);
    const out = downsample2d(px, 2, 2, 1, 1);
    expect(out[0]).toBe(128);
    expect(out[1]).toBe(128);
    expect(out[2]).toBe(128);
    expect(out[3]).toBe(255);
  });
});

describe('separableBlur', () => {
  it('spreads an impulse horizontally and vertically', () => {
    const px = solidRgba(5, 5, 0, 0, 0);
    px[(2 * 5 + 2) * 4] = 255;
    const out = separableBlur(px, 5, 5, 1);
    expect(out[(2 * 5 + 2) * 4]!).toBeGreaterThan(20);
    expect(out[(2 * 5 + 1) * 4]!).toBeGreaterThan(0);
    expect(out[0]!).toBe(0);
  });
});

describe('selectBackend prefer:auto break-even', () => {
  it('keeps small stills on CPU even when GPU is adopted', () => {
    const sel = selectBackend({
      op: 'luma_histogram_bt709',
      prefer: 'auto',
      width: 64,
      height: 64,
      gpuAvailable: true,
      workerAvailable: true,
    });
    expect(sel.backend).toBe('cpu');
    expect(sel.reason).toMatch(/CPU|below/i);
  });

  it('selects WebGPU for large histogram when a device is adopted', () => {
    const sel = selectBackend({
      op: 'luma_histogram_bt709',
      prefer: 'auto',
      width: 1920,
      height: 1080,
      gpuAvailable: true,
      workerAvailable: true,
    });
    expect(sel.backend).toBe('webgpu');
    expect(1920 * 1080).toBeGreaterThan(GPU_MIN_PIXELS);
  });

  it('skips GPU downsample when dest is not much smaller', () => {
    const sel = selectBackend({
      op: 'downsample_2d',
      prefer: 'auto',
      width: 1920,
      height: 1080,
      outWidth: 1920,
      outHeight: 1080,
      gpuAvailable: true,
      workerAvailable: false,
    });
    expect(sel.backend).toBe('cpu');
  });

  it('selects WebGPU for large downsample to a library thumb', () => {
    const sel = selectBackend({
      op: 'downsample_2d',
      prefer: 'auto',
      width: 1920,
      height: 1080,
      outWidth: 96,
      outHeight: 54,
      gpuAvailable: true,
      workerAvailable: true,
    });
    expect(sel.backend).toBe('webgpu');
  });

  it('uses worker when GPU is missing and the still is medium+', () => {
    const sel = selectBackend({
      op: 'luma_histogram_bt709',
      prefer: 'auto',
      width: 512,
      height: 512,
      gpuAvailable: false,
      workerAvailable: true,
    });
    expect(sel.backend).toBe('wasm');
  });
});

describe('gpuComputeAvailable + kill switch', () => {
  afterEach(() => {
    __resetGpuChoreDiagnosticsForTests();
    __resetGpuChoresDeviceForTests();
    __resetPreviewWorkerChoresForTests();
  });

  it('reports no device without adoption', () => {
    const avail = gpuComputeAvailable();
    expect(avail.available).toBe(false);
    expect(avail.reason).toMatch(/no GPUDevice/i);
  });

  it('reports preview worker GPU when the compositor worker is registered', () => {
    setPreviewWorkerChoresRunner({
      runJobs: async () => [],
    });
    const avail = gpuComputeAvailable();
    expect(avail.available).toBe(true);
    expect(avail.reason).toMatch(/preview worker GPU/i);
  });

  it('honors ?no_gpu_compute even if a device is adopted', () => {
    __setGpuComputeKillSwitchForTests(true);
    adoptGpuDevice({} as GPUDevice);
    setPreviewWorkerChoresRunner({
      runJobs: async () => [],
    });
    const avail = gpuComputeAvailable();
    expect(avail.available).toBe(false);
    expect(avail.reason).toMatch(/no_gpu_compute/);
    expect(isGpuComputeKillSwitchEnabled()).toBe(true);
  });
});

describe('runJob CPU fallback', () => {
  afterEach(() => {
    __resetGpuChoreDiagnosticsForTests();
    __resetGpuChoresDeviceForTests();
    __resetPreviewWorkerChoresForTests();
  });

  it('runs histogram on CPU when prefer is cpu', async () => {
    const result = await runJob({
      op: 'luma_histogram_bt709',
      prefer: 'cpu',
      pixels: solidRgba(8, 8, 128, 128, 128),
      width: 8,
      height: 8,
    });
    expect(result.backend).toBe('cpu');
    expect(result.histogram).toHaveLength(256);
    expect(result.histogram!.reduce((a, b) => a + b, 0)).toBe(64);
  });

  it('does not use WebGPU when prefer auto and the still is small', async () => {
    adoptGpuDevice({} as GPUDevice);
    const result = await runJob({
      op: 'luma_histogram_bt709',
      prefer: 'auto',
      pixels: solidRgba(32, 32, 10, 20, 30),
      width: 32,
      height: 32,
    });
    expect(result.backend).toBe('cpu');
  });

  it('falls back to CPU when prefer webgpu but the adopted device is a stub', async () => {
    __setGpuComputeKillSwitchForTests(false);
    adoptGpuDevice({} as GPUDevice);
    const result = await runJob({
      op: 'downsample_2d',
      prefer: 'webgpu',
      pixels: solidRgba(4, 4, 255, 0, 0),
      width: 4,
      height: 4,
      outWidth: 2,
      outHeight: 2,
    });
    expect(result.backend).toBe('cpu');
    expect(result.pixels).toHaveLength(2 * 2 * 4);
    expect(result.reason).toMatch(/CPU|failed|vanished/i);
  });

  it('runs histogram from an ImageBitmap source without a pixel buffer', async () => {
    if (typeof createImageBitmap !== 'function') return;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const bitmap = await createImageBitmap(canvas);
    const result = await runJob({
      op: 'luma_histogram_bt709',
      prefer: 'cpu',
      source: bitmap,
      width: 2,
      height: 2,
    });
    expect(result.backend).toBe('cpu');
    expect(result.histogram).toHaveLength(256);
    expect(result.histogram!.reduce((a, b) => a + b, 0)).toBe(4);
    bitmap.close();
  });

  it('hops ImageBitmap jobs to the preview worker GPU when registered', async () => {
    if (typeof createImageBitmap !== 'function') return;
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const bitmap = await createImageBitmap(canvas);
    const hist = new Uint32Array(256);
    hist[0] = 16;
    setPreviewWorkerChoresRunner({
      runJobs: async (jobs, source) => {
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.op).toBe('luma_histogram_bt709');
        expect(source).toBeInstanceOf(ImageBitmap);
        return [
          {
            backend: 'webgpu',
            reason: 'preview worker GPU',
            histogram: hist,
            levels: { black: 0, white: 0, mean: 0 },
          },
        ];
      },
    });
    const result = await runJob({
      op: 'luma_histogram_bt709',
      prefer: 'webgpu',
      source: bitmap,
      width: 4,
      height: 4,
    });
    expect(result.backend).toBe('webgpu');
    expect(result.histogram![0]).toBe(16);
    bitmap.close();
  });
});

describe('analyzeImportedStillPixels', () => {
  it('returns 256 bins, levels, and a poster when canvas is available', async () => {
    const stats = await analyzeImportedStillPixels(solidRgba(16, 16, 40, 80, 120), 16, 16);
    expect(stats.lumaHistogram).toHaveLength(256);
    expect(stats.lumaLevels.white).toBeGreaterThanOrEqual(stats.lumaLevels.black);
    expect(stats.gpuChoreBackend).toBe('cpu');
  });
});

describe('bitmapDimensions', () => {
  it('reads width/height from a canvas without getImageData', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 27;
    expect(bitmapDimensions(canvas)).toEqual({ width: 48, height: 27 });
  });
});
