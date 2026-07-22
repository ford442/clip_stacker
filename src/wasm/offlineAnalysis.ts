/**
 * Offline FFT / beat analysis over a full AudioBuffer (or raw PCM).
 * Runs analysis hops via the WASM module; suitable for clip load-time metadata.
 */

import {
  createAudioAnalyzer,
  type AudioAnalyzerHandle,
  type AudioBandEnergies,
} from './audioAnalysis';

export interface OfflineAnalysisOptions {
  fftSize?: number;
  /** Directory URL for WASM assets (tests / non-root deploy). */
  baseUrl?: string;
  /**
   * Peak threshold for recording a beat timestamp from the envelope.
   * Default 0.85 — captures onset impulses from the WASM detector.
   */
  beatPeakThreshold?: number;
}

export interface OfflineAnalysisResult {
  available: boolean;
  reason?: string;
  /** Beat times in seconds from the start of the PCM. */
  beatTimestamps: number[];
  /** Rough BPM from median inter-beat interval (when ≥ 2 beats). */
  bpmEstimate?: number;
  /** Optional downsampled band energy timeline (bass/mid/treble per hop). */
  frameEnergies?: Array<Pick<AudioBandEnergies, 'bass' | 'mid' | 'treble' | 'beat'>>;
  sampleRate: number;
  durationSec: number;
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const out = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      out[i]! += data[i]! / numberOfChannels;
    }
  }
  return out;
}

function estimateBpm(beats: number[]): number | undefined {
  if (beats.length < 2) return undefined;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const dt = beats[i]! - beats[i - 1]!;
    if (dt > 0.25 && dt < 2.0) intervals.push(dt);
  }
  if (intervals.length === 0) return undefined;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)]!;
  return 60 / median;
}

/**
 * Analyze mono PCM with an existing analyzer handle (worker / reuse).
 */
export function analyzePcmWithHandle(
  analyzer: AudioAnalyzerHandle,
  pcm: Float32Array,
  options: OfflineAnalysisOptions = {},
): OfflineAnalysisResult {
  const { fftSize = analyzer.fftSize, beatPeakThreshold = 0.85 } = options;
  const hop = analyzer.hopSize || Math.floor(fftSize / 2);
  const sampleRate = analyzer.sampleRate;
  const beatTimestamps: number[] = [];
  const frameEnergies: OfflineAnalysisResult['frameEnergies'] = [];

  analyzer.reset();

  let lastBeatSec = -1;
  for (let offset = 0; offset + hop <= pcm.length; offset += hop) {
    const frame = pcm.subarray(offset, offset + fftSize);
    const energies = analyzer.analyze(frame);
    const t = offset / sampleRate;
    frameEnergies.push({
      bass: energies.bass,
      mid: energies.mid,
      treble: energies.treble,
      beat: energies.beat,
    });
    if (energies.beat >= beatPeakThreshold && t - lastBeatSec >= 0.28) {
      beatTimestamps.push(t);
      lastBeatSec = t;
    }
  }

  return {
    available: true,
    beatTimestamps,
    bpmEstimate: estimateBpm(beatTimestamps),
    frameEnergies,
    sampleRate,
    durationSec: pcm.length / sampleRate,
  };
}

/**
 * Decode-path helper: analyze a Web Audio AudioBuffer offline.
 */
export async function analyzeAudioBuffer(
  buffer: AudioBuffer,
  options: OfflineAnalysisOptions = {},
): Promise<OfflineAnalysisResult> {
  const fftSize = options.fftSize ?? 2048;
  const analyzer = await createAudioAnalyzer(buffer.sampleRate, fftSize, {
    baseUrl: options.baseUrl,
  });

  if (!analyzer.available) {
    return {
      available: false,
      reason: analyzer.reason,
      beatTimestamps: [],
      sampleRate: buffer.sampleRate,
      durationSec: buffer.duration,
    };
  }

  try {
    const pcm = mixToMono(buffer);
    return analyzePcmWithHandle(analyzer, pcm, options);
  } finally {
    analyzer.destroy();
  }
}

/**
 * Attach beat metadata onto a clip-like object (mutates).
 */
export function applyBeatMetadata<T extends { beatTimestamps?: number[]; bpmEstimate?: number }>(
  clip: T,
  result: OfflineAnalysisResult,
): T {
  if (!result.available || result.beatTimestamps.length === 0) {
    return clip;
  }
  clip.beatTimestamps = result.beatTimestamps.slice();
  if (result.bpmEstimate != null) {
    clip.bpmEstimate = result.bpmEstimate;
  }
  return clip;
}
