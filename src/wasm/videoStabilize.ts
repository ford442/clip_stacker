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

import {
  CS_STATUS,
  describeStatus,
  getEmscriptenLoadFailure,
  loadEmscriptenModule,
  withHeap,
  _resetEmscriptenModuleForTests,
} from './emscriptenLoader';

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
  /**
   * Push one 8-bit grayscale frame (`width * height` bytes). Returns its
   * index; throws when the module refuses it (out of memory, after finalize).
   */
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
}

const MODULE_NAME = 'video_stabilize';

/** Load the Emscripten module once. Returns null on failure (feature disabled). */
export async function loadVideoStabilizeModule(options?: {
  /** Directory URL containing video_stabilize.js / .wasm (trailing slash optional). */
  baseUrl?: string;
}): Promise<WasmModule | null> {
  return loadEmscriptenModule<WasmModule>(MODULE_NAME, 'createVideoStabilizeModule', options);
}

/** Reset cached load state (tests only). */
export function _resetVideoStabilizeLoadStateForTests(): void {
  _resetEmscriptenModuleForTests(MODULE_NAME);
}

export function getVideoStabilizeLoadFailure(): string | null {
  return getEmscriptenLoadFailure(MODULE_NAME);
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
    return { available: false, reason: getVideoStabilizeLoadFailure() || 'WASM module unavailable' };
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
  let destroyed = false;
  let finalized = false;

  /** `count` matrices from `first`, one heap round-trip. */
  const readMatrices = (first: number, count: number): Float32Array | null =>
    withHeap(mod, (heap) => {
      const out = new Float32Array(count * STAB_MATRIX_FLOATS);
      const ptr = heap.alloc(STAB_MATRIX_FLOATS * 4);
      for (let i = 0; i < count; i++) {
        mod._stab_get_matrix(handle, first + i, ptr);
        out.set(heap.f32View(ptr, STAB_MATRIX_FLOATS), i * STAB_MATRIX_FLOATS);
      }
      return out;
    });

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
      const index = withHeap(mod, (heap) =>
        mod._stab_push_frame(handle, heap.u8(grayFrame.subarray(0, grayBytes))),
      );
      if (index === null) throw new Error('WASM heap allocation failed for a stabilizer frame');
      if (index < 0) throw new Error(`stab_push_frame failed (${describeStatus(index)})`);
      return index;
    },

    finalize(): void {
      if (destroyed || finalized) return;
      const rc = mod._stab_finalize(handle);
      if (rc !== CS_STATUS.OK && rc !== CS_STATUS.ESTATE) {
        throw new Error(`stab_finalize failed (${describeStatus(rc)})`);
      }
      // ESTATE (no frames) leaves every matrix at identity, as documented.
      finalized = true;
    },

    getMatrix(frameIdx: number): StabMatrix {
      if (destroyed) return IDENTITY_STAB_MATRIX;
      const m = readMatrices(frameIdx | 0, 1);
      return m ? [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!] : IDENTITY_STAB_MATRIX;
    },

    getAllMatrices(): Float32Array {
      if (destroyed) return new Float32Array(0);
      const count = mod._stab_frame_count(handle);
      const all = readMatrices(0, count);
      if (!all) throw new Error('WASM heap allocation failed reading stabilization matrices');
      return all;
    },

    applyWarp(rgbaIn: Uint8Array, frameIdx: number): Uint8Array {
      const bytes = grayBytes * 4;
      if (destroyed) return rgbaIn.slice(0, bytes);
      if (rgbaIn.length < bytes) {
        throw new Error(`warp expects ${bytes} RGBA bytes, got ${rgbaIn.length}`);
      }
      const warped = withHeap(mod, (heap) => {
        const inPtr = heap.u8(rgbaIn.subarray(0, bytes));
        const outPtr = heap.alloc(bytes);
        mod._stab_apply_warp(handle, inPtr, outPtr, frameIdx | 0);
        return heap.u8View(outPtr, bytes).slice();
      });
      if (!warped) throw new Error('WASM heap allocation failed for warp buffers');
      return warped;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      mod._stab_destroy(handle);
    },
  };

  return stabilizer;
}
