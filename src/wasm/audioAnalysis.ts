/**
 * Lazy loader + typed bindings for the audio analysis WASM module.
 *
 * Feature gracefully disables when the module fails to load (no crash).
 */

export const AUDIO_ANALYSIS_BAND_COUNT = 8;

export interface AudioBandEnergies {
  /** 8 log-spaced band energies in [0, 1]. */
  bands: Float32Array;
  /** Beat onset envelope in [0, 1]. */
  beat: number;
  /** Aggregates for WebGPU uniforms. */
  bass: number;
  mid: number;
  treble: number;
}

export interface AudioAnalyzerHandle {
  analyze(pcm: Float32Array): AudioBandEnergies;
  reset(): void;
  destroy(): void;
  readonly hopSize: number;
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly available: true;
}

export interface UnavailableAnalyzer {
  available: false;
  reason: string;
}

export type AudioAnalyzer = AudioAnalyzerHandle | UnavailableAnalyzer;

interface WasmModule {
  _createAnalyzer(sampleRate: number, fftSize: number): number;
  _analyzeFrame(
    handle: number,
    pcmPtr: number,
    numSamples: number,
    bandsPtr: number,
    beatPtr: number,
  ): void;
  _resetAnalyzer(handle: number): void;
  _destroyAnalyzer(handle: number): void;
  _getHopSize(handle: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

type ModuleFactory = (opts?: { locateFile?: (path: string) => string }) => Promise<WasmModule>;

let loadPromise: Promise<WasmModule | null> | null = null;
let loadFailedReason: string | null = null;

/** Repo-relative public assets (Node / Vitest). */
const NODE_WASM_BASE = new URL('../../public/wasm/', import.meta.url);

function resolveAssetUrl(fileName: string, baseUrl?: string): string {
  if (baseUrl) {
    const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(fileName, root).href;
  }
  // Browser: Vite serves `public/wasm` at `<base>wasm/` (same pattern as ffmpeg-core).
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const base = document.baseURI || window.location.href;
    return new URL(`wasm/${fileName}`, base).href;
  }
  return new URL(fileName, NODE_WASM_BASE).href;
}

/**
 * Load the Emscripten module once. Returns null on failure (feature disabled).
 */
export async function loadAudioAnalysisModule(options?: {
  /** Directory URL containing audio_analysis.js / .wasm (trailing slash optional). */
  baseUrl?: string;
}): Promise<WasmModule | null> {
  if (loadFailedReason) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const jsUrl = resolveAssetUrl('audio_analysis.js', options?.baseUrl);
      const wasmUrl = resolveAssetUrl('audio_analysis.wasm', options?.baseUrl);

      // Dynamic import of the MODULARIZE/EXPORT_ES6 glue.
      const mod = (await import(/* @vite-ignore */ jsUrl)) as {
        default: ModuleFactory;
      };
      const factory = mod.default;
      if (typeof factory !== 'function') {
        throw new Error('audio_analysis module factory missing');
      }

      const instance = await factory({
        locateFile: (path: string) => {
          if (path.endsWith('.wasm')) return wasmUrl;
          return resolveAssetUrl(path, options?.baseUrl);
        },
      });
      return instance;
    } catch (err) {
      loadFailedReason = (err as Error)?.message || String(err);
      console.warn(
        '[audioAnalysis] WASM load failed — audio-reactive analysis disabled:',
        loadFailedReason,
      );
      return null;
    }
  })();

  return loadPromise;
}

/** Reset cached load state (tests only). */
export function _resetAudioAnalysisLoadStateForTests(): void {
  loadPromise = null;
  loadFailedReason = null;
}

export function getAudioAnalysisLoadFailure(): string | null {
  return loadFailedReason;
}

function aggregateBands(bands: Float32Array): Pick<AudioBandEnergies, 'bass' | 'mid' | 'treble'> {
  // bands 0–1 bass, 2–4 mid, 5–7 treble
  const avg = (start: number, end: number) => {
    let s = 0;
    for (let i = start; i <= end; i++) s += bands[i] ?? 0;
    return s / (end - start + 1);
  };
  return {
    bass: avg(0, 1),
    mid: avg(2, 4),
    treble: avg(5, 7),
  };
}

/**
 * Create an analyzer. When WASM is unavailable, returns `{ available: false }`.
 */
export async function createAudioAnalyzer(
  sampleRate: number,
  fftSize = 2048,
  options?: { baseUrl?: string },
): Promise<AudioAnalyzer> {
  const mod = await loadAudioAnalysisModule(options);
  if (!mod) {
    return {
      available: false,
      reason: loadFailedReason || 'WASM module unavailable',
    };
  }

  const handle = mod._createAnalyzer(sampleRate | 0, fftSize | 0);
  if (!handle) {
    return { available: false, reason: 'createAnalyzer returned null' };
  }

  const hopSize = mod._getHopSize(handle) || fftSize / 2;
  const pcmPtr = mod._malloc(fftSize * 4);
  const bandsPtr = mod._malloc(AUDIO_ANALYSIS_BAND_COUNT * 4);
  const beatPtr = mod._malloc(4);

  if (!pcmPtr || !bandsPtr || !beatPtr) {
    mod._destroyAnalyzer(handle);
    if (pcmPtr) mod._free(pcmPtr);
    if (bandsPtr) mod._free(bandsPtr);
    if (beatPtr) mod._free(beatPtr);
    return { available: false, reason: 'WASM heap allocation failed' };
  }

  let destroyed = false;

  const analyzer: AudioAnalyzerHandle = {
    available: true,
    sampleRate,
    fftSize,
    hopSize,
    analyze(pcm: Float32Array): AudioBandEnergies {
      if (destroyed) {
        return {
          bands: new Float32Array(AUDIO_ANALYSIS_BAND_COUNT),
          beat: 0,
          bass: 0,
          mid: 0,
          treble: 0,
        };
      }
      const n = Math.min(pcm.length, fftSize);
      const heap = mod.HEAPF32;
      const pcmOffset = pcmPtr >> 2;
      for (let i = 0; i < fftSize; i++) {
        heap[pcmOffset + i] = i < n ? pcm[i]! : 0;
      }
      mod._analyzeFrame(handle, pcmPtr, n, bandsPtr, beatPtr);
      const bands = new Float32Array(AUDIO_ANALYSIS_BAND_COUNT);
      const bandsOffset = bandsPtr >> 2;
      for (let i = 0; i < AUDIO_ANALYSIS_BAND_COUNT; i++) {
        bands[i] = heap[bandsOffset + i] ?? 0;
      }
      const beat = heap[beatPtr >> 2] ?? 0;
      return { bands, beat, ...aggregateBands(bands) };
    },
    reset() {
      if (!destroyed) mod._resetAnalyzer(handle);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      mod._destroyAnalyzer(handle);
      mod._free(pcmPtr);
      mod._free(bandsPtr);
      mod._free(beatPtr);
    },
  };

  return analyzer;
}

/** Pack bass/mid/treble/beat for a WebGPU uniform buffer write. */
export function toAudioReactiveUniforms(energies: AudioBandEnergies): Float32Array {
  return new Float32Array([energies.bass, energies.mid, energies.treble, energies.beat]);
}
