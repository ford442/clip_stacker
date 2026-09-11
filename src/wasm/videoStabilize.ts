/**
 * Lazy loader + typed bindings for the video stabilization WASM module.
 *
 * Feature gracefully disables when the module fails to load (no crash) — the
 * caller gets `{ available: false, reason }` and leaves the clip unstabilized.
 *
 * Analysis is two-phase, mirroring `native/video_stabilize/video_stabilize.h`:
 * push every frame, `finalize()`, then read matrices. The trajectory smoother
 * is a centred moving average, so no correction exists until the last frame
 * has been seen.
 */

import { getWasmPublicBaseUrl } from './audioAnalysis';

/** Floats per correction matrix: [a, b, tx, c, d, ty]. */
export const STAB_MATRIX_FLOATS = 6;

/** Inverse-warp affine in normalized UV space, centred on the frame. */
export type StabMatrix = readonly [number, number, number, number, number, number];

export const IDENTITY_STAB_MATRIX: StabMatrix = [1, 0, 0, 0, 1, 0];

export interface StabilizerHandle {
  readonly available: true;
  readonly width: number;
  readonly height: number;
  readonly smoothRadius: number;
  /** Push one 8-bit grayscale frame (`width * height` bytes). Returns its index. */
  pushFrame(gray: Uint8Array): number;
  /** Frames pushed so far. */
  readonly frameCount: number;
  /** Smooth the trajectory and build corrections. Idempotent. */
  finalize(): void;
  /** Correction for one frame. Identity before `finalize()` or out of range. */
  getMatrix(frameIdx: number): StabMatrix;
  /** All corrections as one flat `frameCount * 6` array (one heap round-trip). */
  getAllMatrices(): Float32Array;
  /** Auto-crop baked into the matrices (>= 1). */
  readonly zoom: number;
  /** Peak correction as a fraction of frame width. */
  readonly maxCorrection: number;
  /** CPU reference warp of one RGBA frame at analysis resolution. */
  applyWarp(rgbaIn: Uint8Array, frameIdx: number): Uint8Array;
  destroy(): void;
}

export interface UnavailableStabilizer {
  available: false;
  reason: string;
}

export type Stabilizer = StabilizerHandle | UnavailableStabilizer;

interface WasmModule {
  _stab_create(width: number, height: number, smoothRadius: number): number;
  _stab_push_frame(handle: number, grayPtr: number): number;
  _stab_frame_count(handle: number): number;
  _stab_finalize(handle: number): number;
  _stab_get_matrix(handle: number, frameIdx: number, outPtr: number): void;
  _stab_get_zoom(handle: number): number;
  _stab_get_max_correction(handle: number): number;
  _stab_apply_warp(handle: number, inPtr: number, outPtr: number, frameIdx: number): void;
  _stab_destroy(handle: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
}

type ModuleFactory = (opts?: { locateFile?: (path: string) => string }) => Promise<WasmModule>;

let loadPromise: Promise<WasmModule | null> | null = null;
let loadFailedReason: string | null = null;

function resolveAssetUrl(fileName: string, baseUrl?: string): string {
  const root = baseUrl
    ? baseUrl.endsWith('/')
      ? baseUrl
      : `${baseUrl}/`
    : getWasmPublicBaseUrl();
  return new URL(fileName, root).href;
}

/** Load the Emscripten module once. Returns null on failure (feature disabled). */
export async function loadVideoStabilizeModule(options?: {
  /** Directory URL containing video_stabilize.js / .wasm (trailing slash optional). */
  baseUrl?: string;
}): Promise<WasmModule | null> {
  if (loadFailedReason) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const jsUrl = resolveAssetUrl('video_stabilize.js', options?.baseUrl);
      const wasmUrl = resolveAssetUrl('video_stabilize.wasm', options?.baseUrl);

      const mod = (await import(/* @vite-ignore */ jsUrl)) as { default: ModuleFactory };
      const factory = mod.default;
      if (typeof factory !== 'function') {
        throw new Error('video_stabilize module factory missing');
      }

      return await factory({
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) return wasmUrl;
          return resolveAssetUrl(path, options?.baseUrl);
        },
      });
    } catch (err) {
      loadFailedReason = (err as Error)?.message || String(err);
      console.warn(
        '[videoStabilize] WASM load failed — stabilization disabled:',
        loadFailedReason,
      );
      return null;
    }
  })();

  return loadPromise;
}

/** Reset cached load state (tests only). */
export function _resetVideoStabilizeLoadStateForTests(): void {
  loadPromise = null;
  loadFailedReason = null;
}

export function getVideoStabilizeLoadFailure(): string | null {
  return loadFailedReason;
}

/**
 * Allocate a stabilizer for `width` x `height` grayscale analysis frames.
 * When WASM is unavailable, returns `{ available: false }`.
 */
export async function createStabilizer(
  width: number,
  height: number,
  smoothRadius = 30,
  options?: { baseUrl?: string },
): Promise<Stabilizer> {
  const mod = await loadVideoStabilizeModule(options);
  if (!mod) {
    return { available: false, reason: loadFailedReason || 'WASM module unavailable' };
  }

  const w = width | 0;
  const h = height | 0;
  if (w <= 0 || h <= 0) {
    return { available: false, reason: `invalid analysis size ${width}x${height}` };
  }

  const handle = mod._stab_create(w, h, smoothRadius | 0);
  if (!handle) {
    return { available: false, reason: 'stab_create returned null' };
  }

  const grayBytes = w * h;
  const grayPtr = mod._malloc(grayBytes);
  const matrixPtr = mod._malloc(STAB_MATRIX_FLOATS * 4);
  if (!grayPtr || !matrixPtr) {
    mod._stab_destroy(handle);
    if (grayPtr) mod._free(grayPtr);
    if (matrixPtr) mod._free(matrixPtr);
    return { available: false, reason: 'WASM heap allocation failed' };
  }

  let destroyed = false;
  let finalized = false;
  /** Lazily allocated: only the CPU warp path needs two full RGBA buffers. */
  let warpInPtr = 0;
  let warpOutPtr = 0;

  const readMatrix = (frameIdx: number): StabMatrix => {
    mod._stab_get_matrix(handle, frameIdx | 0, matrixPtr);
    const base = matrixPtr >> 2;
    const heap = mod.HEAPF32;
    return [
      heap[base]!,
      heap[base + 1]!,
      heap[base + 2]!,
      heap[base + 3]!,
      heap[base + 4]!,
      heap[base + 5]!,
    ];
  };

  const stabilizer: StabilizerHandle = {
    available: true,
    width: w,
    height: h,
    smoothRadius: smoothRadius | 0,

    get frameCount(): number {
      return destroyed ? 0 : mod._stab_frame_count(handle);
    },

    get zoom(): number {
      return destroyed ? 1 : mod._stab_get_zoom(handle);
    },

    get maxCorrection(): number {
      return destroyed ? 0 : mod._stab_get_max_correction(handle);
    },

    pushFrame(grayFrame: Uint8Array): number {
      if (destroyed) return -1;
      if (grayFrame.length < grayBytes) {
        throw new Error(
          `stabilizer expects ${grayBytes} gray bytes, got ${grayFrame.length}`,
        );
      }
      // subarray keeps an oversized source (e.g. a pooled buffer) from
      // overrunning the heap allocation.
      mod.HEAPU8.set(grayFrame.subarray(0, grayBytes), grayPtr);
      return mod._stab_push_frame(handle, grayPtr);
    },

    finalize(): void {
      if (destroyed || finalized) return;
      mod._stab_finalize(handle);
      finalized = true;
    },

    getMatrix(frameIdx: number): StabMatrix {
      if (destroyed) return IDENTITY_STAB_MATRIX;
      return readMatrix(frameIdx);
    },

    getAllMatrices(): Float32Array {
      if (destroyed) return new Float32Array(0);
      const count = mod._stab_frame_count(handle);
      const out = new Float32Array(count * STAB_MATRIX_FLOATS);
      for (let i = 0; i < count; i++) {
        mod._stab_get_matrix(handle, i, matrixPtr);
        out.set(
          mod.HEAPF32.subarray(matrixPtr >> 2, (matrixPtr >> 2) + STAB_MATRIX_FLOATS),
          i * STAB_MATRIX_FLOATS,
        );
      }
      return out;
    },

    applyWarp(rgbaIn: Uint8Array, frameIdx: number): Uint8Array {
      const bytes = grayBytes * 4;
      if (destroyed) return rgbaIn.slice(0, bytes);
      if (rgbaIn.length < bytes) {
        throw new Error(`warp expects ${bytes} RGBA bytes, got ${rgbaIn.length}`);
      }
      if (!warpInPtr) warpInPtr = mod._malloc(bytes);
      if (!warpOutPtr) warpOutPtr = mod._malloc(bytes);
      if (!warpInPtr || !warpOutPtr) {
        throw new Error('WASM heap allocation failed for warp buffers');
      }
      mod.HEAPU8.set(rgbaIn.subarray(0, bytes), warpInPtr);
      mod._stab_apply_warp(handle, warpInPtr, warpOutPtr, frameIdx | 0);
      return mod.HEAPU8.slice(warpOutPtr, warpOutPtr + bytes);
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      mod._stab_destroy(handle);
      mod._free(grayPtr);
      mod._free(matrixPtr);
      if (warpInPtr) mod._free(warpInPtr);
      if (warpOutPtr) mod._free(warpOutPtr);
    },
  };

  return stabilizer;
}
