import type { GpuChoreBackend, GpuChoreOp, GpuChorePrefer } from './types';

/**
 * Break-even notes (CPU vs GPU upload + dispatch + tiny readback):
 *
 * Histogram reads back 1 KiB (256×u32). The cost is uploading a full-res
 * texture. Below ~1 megapixel, a tight TS loop beats GPU round-trip on typical
 * integrated GPUs (Chromashift / this host). At 4K (8.3 MP) GPU wins if a
 * device is already live.
 *
 * Downsample: GPU only when the source is large *and* the dest is at least 4×
 * smaller (library thumbs). Small stills stay on Canvas2D / CPU bilinear.
 *
 * Blur: GPU when `pixels * radius` is large enough to dwarf buffer setup.
 *
 * Worker (`wasm` backend): used for medium+ stills when GPU is skipped, so the
 * main thread is not stuck in the TS loop. Tiny images stay in-process CPU
 * (postMessage overhead dominates).
 */

/** Histogram / downsample GPU floor (1 megapixel). */
export const GPU_MIN_PIXELS = 1024 * 1024;

/** Worker floor — below this, main-thread CPU is cheaper than postMessage. */
export const WORKER_MIN_PIXELS = 256 * 256;

/** Downsample: dest must be this much smaller than source to bother with GPU. */
export const DOWNSAMPLE_MIN_REDUCTION = 4;

/** separable_blur GPU floor: pixelCount * radius. */
export const BLUR_GPU_MIN_COST = 2_000_000;

export interface BackendSelection {
  backend: GpuChoreBackend;
  reason: string;
}

export function pixelCount(width: number, height: number): number {
  return Math.max(0, width) * Math.max(0, height);
}

export function selectBackend(options: {
  op: GpuChoreOp;
  prefer: GpuChorePrefer;
  width: number;
  height: number;
  outWidth?: number;
  outHeight?: number;
  radius?: number;
  gpuAvailable: boolean;
  workerAvailable: boolean;
}): BackendSelection {
  const { op, prefer, width, height, gpuAvailable, workerAvailable } = options;
  const pixels = pixelCount(width, height);

  if (prefer === 'cpu') {
    return { backend: 'cpu', reason: 'prefer:cpu' };
  }

  if (prefer === 'webgpu') {
    if (gpuAvailable) {
      return { backend: 'webgpu', reason: 'prefer:webgpu (adopted device)' };
    }
    return fallbackCpuOrWorker(workerAvailable, pixels, 'prefer:webgpu but no adopted GPUDevice');
  }

  if (prefer === 'wasm') {
    if (workerAvailable) {
      return { backend: 'wasm', reason: 'prefer:wasm (chores worker)' };
    }
    return { backend: 'cpu', reason: 'prefer:wasm but worker unavailable; main-thread CPU' };
  }

  // prefer: auto
  if (gpuAvailable && meetsGpuBreakEven(op, options)) {
    return {
      backend: 'webgpu',
      reason: `prefer:auto WebGPU (≥ ${GPU_MIN_PIXELS} px, adopted device)`,
    };
  }

  const gpuSkip = gpuAvailable
    ? `below ${op} GPU break-even (${pixels} px)`
    : 'no adopted GPUDevice on this thread';

  if (workerAvailable && pixels >= WORKER_MIN_PIXELS) {
    return {
      backend: 'wasm',
      reason: `prefer:auto worker (${gpuSkip})`,
    };
  }

  return {
    backend: 'cpu',
    reason: `prefer:auto CPU (${gpuSkip}; ${pixels} px)`,
  };
}

function meetsGpuBreakEven(
  op: GpuChoreOp,
  options: {
    width: number;
    height: number;
    outWidth?: number;
    outHeight?: number;
    radius?: number;
  },
): boolean {
  const pixels = pixelCount(options.width, options.height);
  if (op === 'luma_histogram_bt709') {
    return pixels >= GPU_MIN_PIXELS;
  }
  if (op === 'downsample_2d') {
    const dest = pixelCount(options.outWidth ?? options.width, options.outHeight ?? options.height);
    return pixels >= GPU_MIN_PIXELS && dest * DOWNSAMPLE_MIN_REDUCTION <= pixels;
  }
  const radius = Math.max(1, options.radius ?? 1);
  return pixels * radius >= BLUR_GPU_MIN_COST;
}

function fallbackCpuOrWorker(
  workerAvailable: boolean,
  pixels: number,
  why: string,
): BackendSelection {
  if (workerAvailable && pixels >= WORKER_MIN_PIXELS) {
    return { backend: 'wasm', reason: `${why}; worker fallback` };
  }
  return { backend: 'cpu', reason: `${why}; CPU fallback` };
}
