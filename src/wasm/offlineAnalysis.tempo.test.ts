import { describe, expect, it } from 'vitest';
import type { AudioAnalyzerHandle } from './audioAnalysis';
import {
  analyzePcmWithHandle,
  applyBeatMetadata,
  estimateBpm,
  type OfflineAnalysisResult,
} from './offlineAnalysis';

const SAMPLE_RATE = 1000;
const HOP = 10; // 10 ms per hop keeps the beat grid easy to reason about.

/**
 * Analyzer stub that reports a beat on the hops listed in `beatHops`, so the
 * tempo logic can be exercised without loading the WASM module.
 */
function stubAnalyzer(beatHops: Set<number>): AudioAnalyzerHandle {
  let hop = 0;
  return {
    analyze: () => {
      const beat = beatHops.has(hop) ? 1 : 0;
      hop += 1;
      return { bands: new Float32Array(8), beat, bass: 0, mid: 0, treble: 0 };
    },
    reset: () => {
      hop = 0;
    },
    destroy: () => {},
    hopSize: HOP,
    sampleRate: SAMPLE_RATE,
    fftSize: HOP * 2,
    available: true,
  };
}

/** Hop indices for a steady `bpm` pulse over `hopCount` hops. */
function beatHopsFor(bpm: number, hopCount: number): Set<number> {
  const hopsPerBeat = Math.round((60 / bpm) * (SAMPLE_RATE / HOP));
  const hops = new Set<number>();
  for (let h = 0; h < hopCount; h += hopsPerBeat) hops.add(h);
  return hops;
}

describe('analyzePcmWithHandle tempo output', () => {
  it('reports a clustered BPM with confidence for a steady pulse', () => {
    const hopCount = 1000;
    const pcm = new Float32Array(hopCount * HOP);
    const result = analyzePcmWithHandle(stubAnalyzer(beatHopsFor(120, hopCount)), pcm, {
      beatPeakThreshold: 0.5,
    });

    expect(result.available).toBe(true);
    expect(result.beatTimestamps.length).toBeGreaterThan(4);
    expect(result.bpmEstimate).toBeCloseTo(120, 3);
    expect(result.bpmConfidence).toBeGreaterThan(0.6);
  });

  it('falls back to the median-IOI estimate for fewer than four beats', () => {
    const hopCount = 160;
    const pcm = new Float32Array(hopCount * HOP);
    const result = analyzePcmWithHandle(
      stubAnalyzer(new Set([0, 50, 100])),
      pcm,
      { beatPeakThreshold: 0.5 },
    );

    expect(result.beatTimestamps).toHaveLength(3);
    expect(result.bpmEstimate).toBe(estimateBpm(result.beatTimestamps));
    expect(result.bpmEstimate).toBeCloseTo(120, 3);
    expect(result.bpmConfidence).toBeUndefined();
  });
});

describe('applyBeatMetadata', () => {
  const result: OfflineAnalysisResult = {
    available: true,
    beatTimestamps: [0, 0.5, 1],
    bpmEstimate: 120,
    bpmConfidence: 0.75,
    sampleRate: SAMPLE_RATE,
    durationSec: 1.5,
  };

  it('writes beats, BPM and confidence onto the target', () => {
    const clip: {
      beatTimestamps?: number[];
      bpmEstimate?: number;
      bpmConfidence?: number;
    } = {};
    applyBeatMetadata(clip, result);
    expect(clip.beatTimestamps).toEqual([0, 0.5, 1]);
    expect(clip.bpmEstimate).toBe(120);
    expect(clip.bpmConfidence).toBe(0.75);
  });

  it('leaves the target untouched when analysis found nothing', () => {
    const clip: { beatTimestamps?: number[]; bpmEstimate?: number } = {};
    applyBeatMetadata(clip, { ...result, beatTimestamps: [] });
    applyBeatMetadata(clip, { ...result, available: false });
    expect(clip.beatTimestamps).toBeUndefined();
    expect(clip.bpmEstimate).toBeUndefined();
  });
});
