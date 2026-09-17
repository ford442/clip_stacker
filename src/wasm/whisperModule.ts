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

import { readWasmBinaryIfFileUrl, type EmscriptenFactory } from './emscriptenLoader';
import { getWasmPublicBaseUrl } from './audioAnalysis';

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

type ModuleFactory = EmscriptenFactory<WhisperModule>;

export const WHISPER_GLUE_FILE = 'whisper.js';
export const WHISPER_WASM_FILE = 'whisper.wasm';

let loadPromise: Promise<WhisperModule | null> | null = null;
let loadFailedReason: string | null = null;

export function resolveWhisperAssetUrl(fileName: string, baseUrl?: string): string {
  const root = baseUrl
    ? baseUrl.endsWith('/')
      ? baseUrl
      : `${baseUrl}/`
    : getWasmPublicBaseUrl();
  return new URL(fileName, root).href;
}

/** Load the module once. Returns null when the build is not deployed. */
export async function loadWhisperModule(options?: {
  baseUrl?: string;
}): Promise<WhisperModule | null> {
  if (loadFailedReason) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const jsUrl = resolveWhisperAssetUrl(WHISPER_GLUE_FILE, options?.baseUrl);
      const wasmUrl = resolveWhisperAssetUrl(WHISPER_WASM_FILE, options?.baseUrl);

      const mod = (await import(/* @vite-ignore */ jsUrl)) as { default: ModuleFactory };
      const factory = mod.default;
      if (typeof factory !== 'function') {
        throw new Error('whisper module factory missing');
      }

      const wasmBinary = await readWasmBinaryIfFileUrl(wasmUrl);
      return await factory({
        ...(wasmBinary ? { wasmBinary } : {}),
        locateFile: (path: string) =>
          path.endsWith('.wasm')
            ? wasmUrl
            : resolveWhisperAssetUrl(path, options?.baseUrl),
      });
    } catch (err) {
      loadFailedReason = (err as Error)?.message || String(err);
      console.warn(
        '[whisper] WASM load failed — auto-captioning disabled:',
        loadFailedReason,
      );
      return null;
    }
  })();

  return loadPromise;
}

export function getWhisperLoadFailure(): string | null {
  return loadFailedReason;
}

export function _resetWhisperLoadStateForTests(): void {
  loadPromise = null;
  loadFailedReason = null;
}

/** Copy a JS string into the module heap. Caller frees the pointer. */
export function allocString(module: WhisperModule, value: string): number {
  const bytes = module.lengthBytesUTF8(value) + 1;
  const ptr = module._malloc(bytes);
  module.stringToUTF8(value, ptr, bytes);
  return ptr;
}
