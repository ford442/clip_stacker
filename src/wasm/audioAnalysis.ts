/**
 * Lazy loader + typed bindings for the audio analysis WASM module.
 *
 * Feature gracefully disables when the module fails to load (no crash).
 */

import {
  CS_STATUS,
  getEmscriptenLoadFailure,
  loadEmscriptenModule,
  withHeap,
  _resetEmscriptenModuleForTests,
} from './emscriptenLoader';

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
  ): number;
  _resetAnalyzer(handle: number): void;
  _destroyAnalyzer(handle: number): void;
  _getHopSize(handle: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

const MODULE_NAME = 'audio_analysis';

/**
 * Load the Emscripten module once. Returns null on failure (feature disabled).
 */
export async function loadAudioAnalysisModule(options?: {
  /** Directory URL containing audio_analysis.js / .wasm (trailing slash optional). */
  baseUrl?: string;
}): Promise<WasmModule | null> {
  return loadEmscriptenModule<WasmModule>(MODULE_NAME, 'createAudioAnalysisModule', options);
}

/** Reset cached load state (tests only). */
export function _resetAudioAnalysisLoadStateForTests(): void {
  _resetEmscriptenModuleForTests(MODULE_NAME);
}

export function getAudioAnalysisLoadFailure(): string | null {
  return getEmscriptenLoadFailure(MODULE_NAME);
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
      reason: getAudioAnalysisLoadFailure() || 'WASM module unavailable',
    };
  }

  const handle = mod._createAnalyzer(sampleRate | 0, fftSize | 0);
  if (!handle) {
    return { available: false, reason: 'createAnalyzer returned null' };
  }

  const hopSize = mod._getHopSize(handle) || fftSize / 2;
  let destroyed = false;
  const silent = (): AudioBandEnergies => ({
    bands: new Float32Array(AUDIO_ANALYSIS_BAND_COUNT),
    beat: 0,
    bass: 0,
    mid: 0,
    treble: 0,
  });

  const analyzer: AudioAnalyzerHandle = {
    available: true,
    sampleRate,
    fftSize,
    hopSize,
    analyze(pcm: Float32Array): AudioBandEnergies {
      if (destroyed) return silent();
      const n = Math.min(pcm.length, fftSize);
      const result = withHeap(mod, (heap) => {
        const pcmPtr = heap.alloc(fftSize * 4);
        const bandsPtr = heap.alloc(AUDIO_ANALYSIS_BAND_COUNT * 4);
        const beatPtr = heap.alloc(4);
        const frame = heap.f32View(pcmPtr, fftSize);
        frame.set(pcm.subarray(0, n));
        frame.fill(0, n);
        if (mod._analyzeFrame(handle, pcmPtr, n, bandsPtr, beatPtr) !== CS_STATUS.OK) return null;
        // Read after the call: analysis may grow the heap and detach older views.
        const bands = heap.readF32(bandsPtr, AUDIO_ANALYSIS_BAND_COUNT);
        const beat = heap.f32View(beatPtr, 1)[0] ?? 0;
        return { bands, beat, ...aggregateBands(bands) };
      });
      return result ?? silent();
    },
    reset() {
      if (!destroyed) mod._resetAnalyzer(handle);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      mod._destroyAnalyzer(handle);
    },
  };

  return analyzer;
}

/** Pack bass/mid/treble/beat for a WebGPU uniform buffer write. */
export function toAudioReactiveUniforms(energies: AudioBandEnergies): Float32Array {
  return new Float32Array([energies.bass, energies.mid, energies.treble, energies.beat]);
}
