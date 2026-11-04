/**
 * Pitch-preserving WSOLA time remap for playbackRate automation curves, run
 * by the media-engine WASM module (`time_stretch_session_*` in
 * `native/media_engine/src/time_stretch.cpp`): one module and one heap with
 * the timeline mixer, reading fractional positions through the same 64-tap
 * polyphase FIR.
 *
 * The session is chunked: each call gets about a second of output and only
 * the window of source it reads, so the WASM heap holds a few MB however
 * long the clip (a 10 minute stereo clip is 230 MB of f32 — the whole-buffer
 * `time_stretch_remap` would need all of it, plus the output, in the heap).
 * Chunked output is bit-identical to the whole-buffer call (host tests).
 *
 * Production runs this in a worker (`src/audio/timeStretchClient.ts`); here
 * it runs in whichever realm imports it.
 *
 * Returns null whenever the WASM path is unavailable — module not loaded,
 * `?no_media_engine`, or the heap cannot hold the buffers — and callers fall
 * back to the JS overlap-add in `remapAudio.ts`.
 */

import { CS_STATUS, describeStatus, withHeap } from './emscriptenLoader';
import { isMediaEngineMixEnabled, loadMediaEngineModule } from './mediaEngine';

interface TimeStretchModule {
  _time_stretch_session_create?(sourceFrames: number, channels: number, hop: number, tolerance: number): number;
  _time_stretch_session_process?(
    session: number,
    windowPtr: number,
    windowFrames: number,
    windowStart: number,
    offsetsPtr: number,
    numOffsets: number,
    outputPtr: number,
    outFrames: number,
  ): number;
  _time_stretch_session_hop?(session: number): number;
  _time_stretch_session_destroy?(session: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

/** Synthesis hop (frames): segments are `2 * hop` long at 50% overlap (~21 ms at 48 kHz). */
export const TIME_STRETCH_HOP = 512;
/** Similarity search radius; negative = the module default, `hop / 2`. */
export const TIME_STRETCH_DEFAULT_TOLERANCE = -1;
/** Output hops per session call: 96 × 512 ≈ 1 s at 48 kHz. */
export const TIME_STRETCH_CHUNK_BLOCKS = 96;
/** Extra source frames each side of a chunk's offsets (beyond `2·hop + tolerance`): the FIR's reach. */
const WINDOW_TAPS = 64;

export interface WasmRemapOptions {
  hop?: number;
  tolerance?: number;
  /** `public/wasm/` base URL (a worker passes main's, so `?wasm_debug` follows). */
  baseUrl?: string;
  /** Output hops per call (tests). */
  chunkBlocks?: number;
  /** Peak WASM heap size seen during the remap (bytes), for tests and diagnostics. */
  onHeapBytes?: (bytes: number) => void;
}

interface ChunkPlan {
  done: number;
  count: number;
  offsetStart: number;
  offsetCount: number;
  first: number;
  frames: number;
}

/** Where every chunk's output, offsets and source window lie. */
function planChunks(
  offsets: Float64Array,
  inFrames: number,
  outFrames: number,
  hop: number,
  tolerance: number,
  chunkBlocks: number,
): ChunkPlan[] {
  const margin = 2 * hop + tolerance + WINDOW_TAPS;
  const plans: ChunkPlan[] = [];
  for (let done = 0; done < outFrames; ) {
    const count = Math.min(chunkBlocks * hop, outFrames - done);
    const offsetStart = Math.min(offsets.length, done / hop);
    const offsetCount = Math.max(0, Math.min(offsets.length - offsetStart, Math.ceil(count / hop) + 1));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = offsetStart; i < offsetStart + offsetCount; i++) {
      lo = Math.min(lo, offsets[i]!);
      hi = Math.max(hi, offsets[i]!);
    }
    const first = offsetCount > 0 ? Math.max(0, Math.min(inFrames, Math.floor(lo - margin))) : 0;
    const last = offsetCount > 0 ? Math.max(first, Math.min(inFrames, Math.ceil(hi + margin))) : 0;
    plans.push({ done, count, offsetStart, offsetCount, first, frames: last - first });
    done += count;
  }
  return plans;
}

/**
 * Remap planar PCM along a dense source-offset curve: `sourceOffsets[h]` is
 * the source frame heard at output frame `h * hop`. Channels are planar
 * (`[ch0..., ch1...]`). Returns planar output, or null to use the fallback.
 */
export async function wasmRemapPlanar(
  inputPlanar: Float32Array,
  inFrames: number,
  channels: number,
  sourceOffsets: Float64Array,
  outFrames: number,
  options: WasmRemapOptions = {},
): Promise<Float32Array | null> {
  if (!isMediaEngineMixEnabled()) return null;
  const mod = (await loadMediaEngineModule({ baseUrl: options.baseUrl })) as TimeStretchModule | null;
  if (
    !mod ||
    typeof mod._time_stretch_session_create !== 'function' ||
    typeof mod._time_stretch_session_process !== 'function' ||
    typeof mod._time_stretch_session_hop !== 'function' ||
    typeof mod._time_stretch_session_destroy !== 'function'
  ) {
    return null;
  }
  const session = mod._time_stretch_session_create(
    inFrames,
    channels,
    options.hop ?? TIME_STRETCH_HOP,
    options.tolerance ?? TIME_STRETCH_DEFAULT_TOLERANCE,
  );
  if (!session) {
    console.warn('[timeStretch] session create failed; using the JS fallback');
    return null;
  }
  try {
    const hop = mod._time_stretch_session_hop(session);
    const requested = options.tolerance ?? TIME_STRETCH_DEFAULT_TOLERANCE;
    const tolerance = requested < 0 ? hop >> 1 : Math.min(requested, hop);
    const chunkBlocks = Math.max(1, Math.floor(options.chunkBlocks ?? TIME_STRETCH_CHUNK_BLOCKS));
    const plans = planChunks(sourceOffsets, inFrames, outFrames, hop, tolerance, chunkBlocks);
    let maxWindow = 1;
    let maxOffsets = 1;
    for (const plan of plans) {
      maxWindow = Math.max(maxWindow, plan.frames);
      maxOffsets = Math.max(maxOffsets, plan.offsetCount);
    }
    const chunkFrames = Math.min(outFrames, chunkBlocks * hop);
    const output = new Float32Array(outFrames * channels);

    // One scope, buffers sized once for the largest chunk: the heap never
    // grows past them (no per-chunk malloc churn).
    const ok = withHeap(mod, (heap) => {
      const windowPtr = heap.alloc(maxWindow * channels * 4);
      const offsetsPtr = heap.alloc(maxOffsets * 8);
      const outPtr = heap.alloc(chunkFrames * channels * 4);
      options.onHeapBytes?.(mod.HEAPU8.byteLength);
      for (const plan of plans) {
        const win = heap.f32View(windowPtr, plan.frames * channels);
        for (let c = 0; c < channels; c++) {
          const plane = c * inFrames;
          win.set(inputPlanar.subarray(plane + plan.first, plane + plan.first + plan.frames), c * plan.frames);
        }
        heap.f64View(offsetsPtr, plan.offsetCount).set(
          sourceOffsets.subarray(plan.offsetStart, plan.offsetStart + plan.offsetCount),
        );
        const rc = mod._time_stretch_session_process!(
          session,
          windowPtr,
          plan.frames,
          plan.first,
          offsetsPtr,
          plan.offsetCount,
          outPtr,
          plan.count,
        );
        if (rc !== CS_STATUS.OK) {
          console.warn(`[timeStretch] remap failed (${describeStatus(rc)}); using the JS fallback`);
          return false;
        }
        const chunk = heap.f32View(outPtr, plan.count * channels);
        for (let c = 0; c < channels; c++) {
          output.set(chunk.subarray(c * plan.count, (c + 1) * plan.count), c * outFrames + plan.done);
        }
      }
      options.onHeapBytes?.(mod.HEAPU8.byteLength);
      return true;
    });
    return ok ? output : null;
  } finally {
    try {
      mod._time_stretch_session_destroy(session);
    } catch {
      // A trapped module throws on every export; withHeap already retired it.
    }
  }
}
