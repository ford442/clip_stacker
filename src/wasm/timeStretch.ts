/**
 * Pitch-preserving WSOLA time remap for playbackRate automation curves, run
 * by the media-engine WASM module (`time_stretch_remap` in
 * `native/media_engine/src/time_stretch.cpp`): one module and one heap with
 * the timeline mixer, reading fractional positions through the same 64-tap
 * polyphase FIR.
 *
 * Returns null whenever the WASM path is unavailable — module not loaded,
 * `?no_media_engine`, or the heap cannot hold the buffers — and callers fall
 * back to the JS overlap-add in `remapAudio.ts`.
 */

import { CS_STATUS, describeStatus, withHeap } from './emscriptenLoader';
import { isMediaEngineMixEnabled, loadMediaEngineModule } from './mediaEngine';

interface TimeStretchModule {
  _time_stretch_remap?(
    inputPtr: number,
    inFrames: number,
    channels: number,
    offsetsPtr: number,
    numOffsets: number,
    hop: number,
    tolerance: number,
    outputPtr: number,
    outFrames: number,
  ): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

/** Synthesis hop (frames): segments are `2 * hop` long at 50% overlap (~21 ms at 48 kHz). */
export const TIME_STRETCH_HOP = 512;
/** Similarity search radius; negative = the module default, `hop / 2`. */
export const TIME_STRETCH_DEFAULT_TOLERANCE = -1;

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
  hop = TIME_STRETCH_HOP,
  tolerance = TIME_STRETCH_DEFAULT_TOLERANCE,
): Promise<Float32Array | null> {
  if (!isMediaEngineMixEnabled()) return null;
  const mod = (await loadMediaEngineModule()) as TimeStretchModule | null;
  if (!mod || typeof mod._time_stretch_remap !== 'function') return null;

  const inSamples = inFrames * channels;
  const outSamples = outFrames * channels;
  const result = withHeap(mod, (heap) => {
    const inPtr = heap.f32(inputPlanar.subarray(0, inSamples));
    const offPtr = heap.f64(sourceOffsets);
    const outPtr = heap.alloc(outSamples * 4);
    const rc = mod._time_stretch_remap!(
      inPtr,
      inFrames,
      channels,
      offPtr,
      sourceOffsets.length,
      hop,
      tolerance,
      outPtr,
      outFrames,
    );
    if (rc !== CS_STATUS.OK) {
      console.warn(`[timeStretch] remap failed (${describeStatus(rc)}); using the JS fallback`);
      return null;
    }
    return heap.readF32(outPtr, outSamples);
  });
  return result ?? null;
}
