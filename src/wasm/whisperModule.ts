/**
 * Lazy loader + typed bindings for the Whisper (speech-to-text) WASM module.
 *
 * Same shape as `audioAnalysis.ts`: the module is optional. When
 * `public/wasm/whisper.js` is absent the loader returns null and the
 * auto-caption feature hides itself — a missing WASM build is never a boot
 * failure.
 *
 * The glue is a whisper.cpp build wrapped by `native/whisper/` (see its
 * README), not whisper.cpp's own `whisper.wasm` example: the upstream example
 * only prints text to stdout, while captions need per-segment timings. The
 * exported C API is:
 *
 * ```c
 * int  whisperInit(const uint8_t* model, int modelBytes);   // 0 on failure
 * void whisperFree(int handle);
 * int  whisperTranscribe(int handle, const float* pcm16k, int samples,
 *                        const char* language, int threads); // segments, <0 error
 * int  whisperSegmentStartMs(int handle, int index);
 * int  whisperSegmentEndMs(int handle, int index);
 * const char* whisperSegmentText(int handle, int index);
 * ```
 *
 * During `whisperTranscribe` the wrapper calls back into JS through
 * `Module.onWhisperProgress(progress0to1)`; returning a non-zero value from
 * that callback aborts the run, which is how cancellation reaches a blocking
 * WASM call.
 */

import {
  getEmscriptenLoadFailure,
  loadEmscriptenModule,
  resolveWasmAssetUrl,
  type HeapScope,
  _resetEmscriptenModuleForTests,
} from './emscriptenLoader';

export interface WhisperModule {
  _whisperInit(modelPtr: number, modelBytes: number): number;
  _whisperFree(handle: number): void;
  _whisperTranscribe(
    handle: number,
    pcmPtr: number,
    samples: number,
    languagePtr: number,
    threads: number,
  ): number;
  _whisperSegmentStartMs(handle: number, index: number): number;
  _whisperSegmentEndMs(handle: number, index: number): number;
  _whisperSegmentText(handle: number, index: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  UTF8ToString(ptr: number): string;
  stringToUTF8(value: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(value: string): number;
  /** Set by us before a run; called by the wrapper. Non-zero return aborts. */
  onWhisperProgress?: (progress: number) => number;
}

export const WHISPER_GLUE_FILE = 'whisper.js';
export const WHISPER_WASM_FILE = 'whisper.wasm';
const MODULE_NAME = 'whisper';

export function resolveWhisperAssetUrl(fileName: string, baseUrl?: string): string {
  return resolveWasmAssetUrl(fileName, baseUrl);
}

/** Load the module once. Returns null when the build is not deployed. */
export async function loadWhisperModule(options?: {
  baseUrl?: string;
}): Promise<WhisperModule | null> {
  return loadEmscriptenModule<WhisperModule>(MODULE_NAME, 'createWhisperModule', options);
}

export function getWhisperLoadFailure(): string | null {
  return getEmscriptenLoadFailure(MODULE_NAME);
}

export function _resetWhisperLoadStateForTests(): void {
  _resetEmscriptenModuleForTests(MODULE_NAME);
}

/** Copy a JS string into the module heap as NUL-terminated UTF-8 (freed with the scope). */
export function allocString(module: WhisperModule, heap: HeapScope, value: string): number {
  const bytes = module.lengthBytesUTF8(value) + 1;
  const ptr = heap.alloc(bytes);
  module.stringToUTF8(value, ptr, bytes);
  return ptr;
}
