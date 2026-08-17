/** GPU-ingestible / worker-rasterizable still sources. */
export type StillBitmapSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | OffscreenCanvas;

export function bitmapDimensions(bitmap: StillBitmapSource): { width: number; height: number } {
  if ('naturalWidth' in bitmap && bitmap.naturalWidth) {
    return { width: bitmap.naturalWidth, height: bitmap.naturalHeight };
  }
  if ('videoWidth' in bitmap && bitmap.videoWidth) {
    return { width: bitmap.videoWidth, height: bitmap.videoHeight };
  }
  return { width: bitmap.width, height: bitmap.height };
}

export function isImageBitmapSource(value: unknown): value is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap;
}

/**
 * Full-res RGBA readback. Prefer calling this in the chores Worker, not on
 * the main thread, for large stills.
 */
export function rasterizeBitmapToRgba(bitmap: StillBitmapSource): {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const { width, height } = bitmapDimensions(bitmap);
  if (width <= 0 || height <= 0) {
    throw new Error('gpu-chores: still has empty dimensions');
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0);
      return { pixels: ctx.getImageData(0, 0, width, height).data, width, height };
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create 2D context to read still pixels');
    ctx.drawImage(bitmap, 0, 0);
    return { pixels: ctx.getImageData(0, 0, width, height).data, width, height };
  }

  throw new Error('gpu-chores: no canvas available to rasterize still');
}

export function closeBitmap(bitmap: StillBitmapSource): void {
  if ('close' in bitmap && typeof bitmap.close === 'function') {
    try {
      bitmap.close();
    } catch {
      /* already detached after transfer */
    }
  }
}
