/** Instantaneous meter reading from the playback AnalyserNode. */
export interface AnalyserLevels {
  /** Broadband RMS in 0–1. */
  rms: number;
  /** Peak sample in 0–1. */
  peak: number;
  /** Low / mid / high band energies in 0–1 (for reactive shaders / meters). */
  bass: number;
  mid: number;
  treble: number;
}

export const ZERO_ANALYSER_LEVELS: AnalyserLevels = {
  rms: 0,
  peak: 0,
  bass: 0,
  mid: 0,
  treble: 0,
};

/** Map a slice of Analyser frequency bins (dB) to a 0–1 energy. */
export function bandEnergy(frequencyDb: Float32Array, start: number, end: number): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    // getFloatFrequencyData is typically −100…0 dB.
    const db = frequencyDb[i];
    const linear = db <= -100 ? 0 : Math.pow(10, db / 20);
    sum += linear;
  }
  return Math.min(1, sum / (end - start));
}
