/**
 * Lazy loader + bindings for the WSOLA time-stretch WASM module.
 * Pitch-preserving remap for variable playbackRate automation curves.
 * Gracefully falls back when the module fails to load.
 */

import { getWasmPublicBaseUrl } from './audioAnalysis';

interface WasmModule {
  _time_stretch_remap(
    inputPtr: number,
    inFrames: number,
    channels: number,
    offsetsPtr: number,
    numOffsets: number,
    hop: number,
    outputPtr: number,
    outFrames: number,
  ): number;
  _time_stretch_constant(
    inputPtr: number,
    inFrames: number,
    channels: number,
    tempo: number,
    outputPtr: number,
    outFrames: number,
    hop: number,
  ): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
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

export async function loadTimeStretchModule(options?: {
  baseUrl?: string;
}): Promise<WasmModule | null> {
  if (loadFailedReason) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const jsUrl = resolveAssetUrl('time_stretch.js', options?.baseUrl);
      const wasmUrl = resolveAssetUrl('time_stretch.wasm', options?.baseUrl);

      const mod = (await import(/* @vite-ignore */ jsUrl)) as {
        default: ModuleFactory;
      };
      const instance = await mod.default({
        locateFile: (path: string) =>
          path.endsWith('.wasm') ? wasmUrl : resolveAssetUrl(path, options?.baseUrl),
      });
      return instance;
    } catch (err) {
      loadFailedReason = err instanceof Error ? err.message : String(err);
      console.warn('[timeStretch] WASM unavailable:', loadFailedReason);
      return null;
    }
  })();

  return loadPromise;
}

/** Reset loader state (tests). */
export function resetTimeStretchLoader(): void {
  loadPromise = null;
  loadFailedReason = null;
}

export function timeStretchLoadFailedReason(): string | null {
  return loadFailedReason;
}

const DEFAULT_HOP = 256;

/**
 * Remap planar PCM with a dense source-offset curve (one offset per hop).
 * Channels are planar: [ch0..., ch1...]. Returns planar output or null.
 */
export async function wasmRemapPlanar(
  inputPlanar: Float32Array,
  inFrames: number,
  channels: number,
  sourceOffsets: Float32Array,
  outFrames: number,
  hop = DEFAULT_HOP,
): Promise<Float32Array | null> {
  const mod = await loadTimeStretchModule();
  if (!mod) return null;

  const inSamples = inFrames * channels;
  const outSamples = outFrames * channels;
  const inPtr = mod._malloc(inSamples * 4);
  const outPtr = mod._malloc(outSamples * 4);
  const offPtr = mod._malloc(sourceOffsets.length * 4);
  try {
    mod.HEAPF32.set(inputPlanar.subarray(0, inSamples), inPtr / 4);
    mod.HEAPF32.set(sourceOffsets, offPtr / 4);
    const rc = mod._time_stretch_remap(
      inPtr,
      inFrames,
      channels,
      offPtr,
      sourceOffsets.length,
      hop,
      outPtr,
      outFrames,
    );
    if (rc !== 0) return null;
    return new Float32Array(mod.HEAPF32.subarray(outPtr / 4, outPtr / 4 + outSamples));
  } finally {
    mod._free(inPtr);
    mod._free(outPtr);
    mod._free(offPtr);
  }
}

/** Constant-tempo stretch (tempo > 1 → faster / shorter). */
export async function wasmConstantStretch(
  inputPlanar: Float32Array,
  inFrames: number,
  channels: number,
  tempo: number,
  outFrames: number,
  hop = DEFAULT_HOP,
): Promise<Float32Array | null> {
  const mod = await loadTimeStretchModule();
  if (!mod) return null;

  const inSamples = inFrames * channels;
  const outSamples = outFrames * channels;
  const inPtr = mod._malloc(inSamples * 4);
  const outPtr = mod._malloc(outSamples * 4);
  try {
    mod.HEAPF32.set(inputPlanar.subarray(0, inSamples), inPtr / 4);
    const rc = mod._time_stretch_constant(
      inPtr,
      inFrames,
      channels,
      tempo,
      outPtr,
      outFrames,
      hop,
    );
    if (rc !== 0) return null;
    return new Float32Array(mod.HEAPF32.subarray(outPtr / 4, outPtr / 4 + outSamples));
  } finally {
    mod._free(inPtr);
    mod._free(outPtr);
  }
}
