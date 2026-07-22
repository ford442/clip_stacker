/**
 * Audio analysis WASM API — FFT band energy + beat onset detection.
 *
 * Built with Emscripten; consumed from TypeScript via src/wasm/audioAnalysis.ts.
 */
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/** Number of log-spaced frequency bands written by analyzeFrame. */
#define AUDIO_ANALYSIS_BAND_COUNT 8

/**
 * Create an analyzer for the given sample rate and FFT size (power of two, 256–8192).
 * Returns an opaque handle, or NULL on failure.
 */
void* createAnalyzer(int sampleRate, int fftSize);

/**
 * Analyze one PCM frame (mono float32 samples).
 *
 * @param handle     Analyzer from createAnalyzer
 * @param pcm        Interleaved or mono float samples in [-1, 1]
 * @param numSamples Number of samples (ideally == fftSize; shorter frames are zero-padded)
 * @param outBands   Exactly AUDIO_ANALYSIS_BAND_COUNT floats (energy 0..1)
 * @param outBeat    Single float: onset impulse (0..1), decays between beats
 */
void analyzeFrame(void* handle, const float* pcm, int numSamples,
                  float* outBands, float* outBeat);

/** Reset spectral / onset state (e.g. when seeking). */
void resetAnalyzer(void* handle);

/** Free analyzer resources. */
void destroyAnalyzer(void* handle);

/** Recommended hop size in samples (~50% overlap). */
int getHopSize(void* handle);

#ifdef __cplusplus
}
#endif
