import { LIBRARY_THUMB_HEIGHT, LIBRARY_THUMB_WIDTH } from '../utils/media';
import { runJob } from './runJob';
import type { GpuChoreBackend, LumaLevels } from './types';

export interface StillImportChoreResult {
  lumaHistogram: number[];
  lumaLevels: LumaLevels;
  posterUrl?: string;
  gpuChoreBackend: GpuChoreBackend;
  gpuChoreReason: string;
}

export async function pixelsFromBitmap(
  bitmap: ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  const width =
    'naturalWidth' in bitmap && bitmap.naturalWidth
      ? bitmap.naturalWidth
      : 'videoWidth' in bitmap && bitmap.videoWidth
        ? bitmap.videoWidth
        : bitmap.width;
  const height =
    'naturalHeight' in bitmap && bitmap.naturalHeight
      ? bitmap.naturalHeight
      : 'videoHeight' in bitmap && bitmap.videoHeight
        ? bitmap.videoHeight
        : bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create 2D context to read still pixels');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { pixels: imageData.data, width, height };
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

/**
 * Histogram + library poster for an imported still. Uses `prefer: 'auto'`
 * so small assets stay on CPU/Worker and large frames can use adopted WebGPU.
 */
export async function analyzeImportedStillPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  source?: GpuChoreJobSource,
): Promise<StillImportChoreResult> {
  const histJob = await runJob({
    op: 'luma_histogram_bt709',
    prefer: 'auto',
    pixels,
    width,
    height,
    source,
  });
  const thumb = await runJob({
    op: 'downsample_2d',
    prefer: 'auto',
    pixels,
    width,
    height,
    source,
    outWidth: LIBRARY_THUMB_WIDTH,
    outHeight: LIBRARY_THUMB_HEIGHT,
  });
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

type GpuChoreJobSource = NonNullable<import('./types').GpuChoreJob['source']>;

export async function analyzeImportedStillFile(file: Blob): Promise<StillImportChoreResult> {
  const bitmap = await decodeStillBitmap(file);
  try {
    const { pixels, width, height } = await pixelsFromBitmap(bitmap);
    const source = bitmap as GpuChoreJobSource;
    return await analyzeImportedStillPixels(pixels, width, height, source);
  } finally {
    if ('close' in bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }
}
