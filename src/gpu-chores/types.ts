/**
 * Shared gpu-chores job API (local stub).
 *
 * Cross-app kernels for import / library / inspector pixel work — not FFmpeg
 * encode/decode and not the WebGPU preview compositor.
 */

export type GpuChoreOp = 'luma_histogram_bt709' | 'downsample_2d' | 'separable_blur';

/** Caller hint. `auto` applies documented break-even thresholds. */
export type GpuChorePrefer = 'auto' | 'webgpu' | 'wasm' | 'cpu';

/**
 * Backend that actually ran the kernel.
 * `wasm` here means the off-thread Worker running the TS/WASM-golden CPU math
 * (no separate image-FFT module; kissfft stays audio-only).
 */
export type GpuChoreBackend = 'webgpu' | 'wasm' | 'cpu';

export interface LumaLevels {
  /** Black point (0–255) at the low clip percentile. */
  black: number;
  /** White point (0–255) at the high clip percentile. */
  white: number;
  /** Mean luma bin (0–255). */
  mean: number;
}

export interface GpuChoreJob {
  op: GpuChoreOp;
  prefer?: GpuChorePrefer;
  /** RGBA8 tightly packed. Required for CPU/Worker; optional for WebGPU if `source` is set. */
  pixels?: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /**
   * GPU-ingestible bitmap. When a device is adopted, histogram/downsample can
   * upload this without a full CPU ImageData copy.
   */
  source?: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | HTMLImageElement;
  /** downsample_2d destination size. */
  outWidth?: number;
  outHeight?: number;
  /** separable_blur radius in pixels (integer ≥ 1). */
  radius?: number;
}

export interface GpuChoreResult {
  backend: GpuChoreBackend;
  reason: string;
  /** 256 Rec.709 luma bins (histogram op). */
  histogram?: Uint32Array;
  levels?: LumaLevels;
  /** RGBA8 output (downsample / blur). */
  pixels?: Uint8ClampedArray;
  width?: number;
  height?: number;
}

export interface GpuComputeAvailability {
  available: boolean;
  reason: string;
}

export interface GpuChoreBreadcrumb {
  op: GpuChoreOp;
  backend: GpuChoreBackend;
  reason: string;
  width: number;
  height: number;
  pixelCount: number;
  at: number;
}
