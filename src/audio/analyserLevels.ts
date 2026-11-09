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

/** Reads an AnalyserNode into `AnalyserLevels`, reusing its sample buffers. */
export class AnalyserLevelReader {
  private timeDomain: Float32Array<ArrayBuffer> | null = null;
  private frequency: Float32Array<ArrayBuffer> | null = null;

  read(analyser: AnalyserNode): AnalyserLevels {
    const binCount = analyser.frequencyBinCount;
    if (!this.timeDomain || this.timeDomain.length !== analyser.fftSize) {
      this.timeDomain = new Float32Array(analyser.fftSize);
    }
    if (!this.frequency || this.frequency.length !== binCount) {
      this.frequency = new Float32Array(binCount);
    }
    const timeDomain = this.timeDomain;
    const frequency = this.frequency;
    analyser.getFloatTimeDomainData(timeDomain);
    analyser.getFloatFrequencyData(frequency);

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const s = timeDomain[i];
      sumSq += s * s;
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, timeDomain.length));

    // Frequency data is in dB (−∞…0). Map bands to 0–1 loosely.
    const bassEnd = Math.floor(binCount * 0.08);
    const midEnd = Math.floor(binCount * 0.4);
    return {
      rms,
      peak,
      bass: bandEnergy(frequency, 0, bassEnd),
      mid: bandEnergy(frequency, bassEnd, midEnd),
      treble: bandEnergy(frequency, midEnd, binCount),
    };
  }
}
