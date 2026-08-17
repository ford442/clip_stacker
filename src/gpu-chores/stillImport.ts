import { LIBRARY_THUMB_HEIGHT, LIBRARY_THUMB_WIDTH } from '../utils/media';
import { GPU_MIN_PIXELS, pixelCount, WORKER_MIN_PIXELS } from './breakEven';
import { gpuComputeAvailable } from './diagnostics';
import { peekChoresGpuDevice } from './device';
import {
  isPreviewWorkerChoresAvailable,
  runPreviewWorkerJobs,
} from './previewWorkerBridge';
import {
  bitmapDimensions,
  closeBitmap,
  isImageBitmapSource,
  rasterizeBitmapToRgba,
  type StillBitmapSource,
} from './rasterize';
import { runJob } from './runJob';
import type { GpuChoreBackend, GpuChoreJobSpec, GpuChoreResult, LumaLevels } from './types';
import { isChoresWorkerAvailable, runWorkerAnalyzeStill } from './worker/gpuChoresClient';

export interface StillImportChoreResult {
  lumaHistogram: number[];
  lumaLevels: LumaLevels;
  posterUrl?: string;
  gpuChoreBackend: GpuChoreBackend;
  gpuChoreReason: string;
}

export { bitmapDimensions, rasterizeBitmapToRgba };

export async function pixelsFromBitmap(
  bitmap: StillBitmapSource,
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  return rasterizeBitmapToRgba(bitmap);
}

export async function decodeStillBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodePosterJpeg(pixels: Uint8ClampedArray, width: number, height: number): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const data = new Uint8ClampedArray(pixels.length);
  data.set(pixels);
  const imageData = new ImageData(data, width, height);
  ctx.putImageData(imageData, 0, 0);
  try {
    return canvas.toDataURL('image/jpeg', 0.5);
  } catch {
    return undefined;
  }
}

function stillJobSpecs(width: number, height: number): { hist: GpuChoreJobSpec; thumb: GpuChoreJobSpec } {
  return {
    hist: {
      op: 'luma_histogram_bt709',
      prefer: 'auto',
      width,
      height,
    },
    thumb: {
      op: 'downsample_2d',
      prefer: 'auto',
      width,
      height,
      outWidth: LIBRARY_THUMB_WIDTH,
      outHeight: LIBRARY_THUMB_HEIGHT,
    },
  };
}

function packStillResults(histJob: GpuChoreResult, thumb: GpuChoreResult): StillImportChoreResult {
  const posterUrl =
    thumb.pixels && thumb.width && thumb.height
      ? encodePosterJpeg(thumb.pixels, thumb.width, thumb.height)
      : undefined;
  return {
    lumaHistogram: Array.from(histJob.histogram ?? []),
    lumaLevels: histJob.levels ?? { black: 0, white: 255, mean: 0 },
    posterUrl,
    gpuChoreBackend: histJob.backend,
    gpuChoreReason: `${histJob.reason}; thumb ${thumb.backend}`,
  };
}

/**
 * Histogram + library poster for an imported still. Uses `prefer: 'auto'`
 * so small assets stay on CPU/Worker and large frames can use adopted WebGPU.
 * Avoids main-thread `getImageData` when GPU (local or preview worker) or the
 * chores Worker can ingest an ImageBitmap.
 */
export async function analyzeImportedStillPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  source?: import('./types').GpuChoreJob['source'],
): Promise<StillImportChoreResult> {
  const specs = stillJobSpecs(width, height);
  const histJob = await runJob({ ...specs.hist, pixels, source });
  const thumb = await runJob({ ...specs.thumb, pixels, source });
  return packStillResults(histJob, thumb);
}

async function analyzeOnLocalGpu(source: StillBitmapSource, width: number, height: number): Promise<StillImportChoreResult> {
  const specs = stillJobSpecs(width, height);
  const histJob = await runJob({ ...specs.hist, source });
  const thumb = await runJob({ ...specs.thumb, source });
  return packStillResults(histJob, thumb);
}

async function analyzeViaPreviewWorker(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<StillImportChoreResult> {
  const specs = stillJobSpecs(width, height);
  const copy =
    typeof createImageBitmap === 'function' ? await createImageBitmap(bitmap) : bitmap;
  const [histJob, thumb] = await runPreviewWorkerJobs([specs.hist, specs.thumb], copy);
  if (!histJob || !thumb) throw new Error('preview worker returned incomplete chore results');
  return packStillResults(histJob, thumb);
}

export async function analyzeImportedStillFile(file: Blob): Promise<StillImportChoreResult> {
  let bitmap = await decodeStillBitmap(file);
  const { width, height } = bitmapDimensions(bitmap);
  const pixels = pixelCount(width, height);
  const gpu = gpuComputeAvailable();
  const wantGpu = gpu.available && pixels >= GPU_MIN_PIXELS;

  const runWithBitmap = async (src: ImageBitmap | HTMLImageElement): Promise<StillImportChoreResult> => {
    if (wantGpu && peekChoresGpuDevice()) {
      return analyzeOnLocalGpu(src, width, height);
    }
    if (wantGpu && isPreviewWorkerChoresAvailable() && isImageBitmapSource(src)) {
      try {
        return await analyzeViaPreviewWorker(src, width, height);
      } catch {
        /* chores Worker / CPU */
      }
    }
    if (
      isChoresWorkerAvailable() &&
      pixels >= WORKER_MIN_PIXELS &&
      isImageBitmapSource(src)
    ) {
      const specs = stillJobSpecs(width, height);
      const [histJob, thumb] = await runWorkerAnalyzeStill(src, [specs.hist, specs.thumb]);
      if (!histJob || !thumb) throw new Error('chores worker returned incomplete still results');
      return packStillResults(histJob, thumb);
    }
    const raster = rasterizeBitmapToRgba(src);
    return analyzeImportedStillPixels(raster.pixels, raster.width, raster.height);
  };

  try {
    return await runWithBitmap(bitmap);
  } catch {
    closeBitmap(bitmap);
    bitmap = await decodeStillBitmap(file);
    const raster = rasterizeBitmapToRgba(bitmap);
    return analyzeImportedStillPixels(raster.pixels, raster.width, raster.height);
  } finally {
    closeBitmap(bitmap);
  }
}
