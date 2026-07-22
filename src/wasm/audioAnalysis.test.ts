import { describe, expect, it, beforeEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  _resetAudioAnalysisLoadStateForTests,
  createAudioAnalyzer,
  toAudioReactiveUniforms,
} from './audioAnalysis';
import { analyzePcmWithHandle } from './offlineAnalysis';

const WASM_BASE = pathToFileURL(
  path.resolve(process.cwd(), 'public/wasm') + path.sep,
).href;

/** Synthetic 120 BPM kick-ish mono clicks (impulse train). */
function makeClickTrack(
  sampleRate: number,
  durationSec: number,
  bpm: number,
): { pcm: Float32Array; expectedBeats: number[] } {
  const n = Math.floor(sampleRate * durationSec);
  const pcm = new Float32Array(n);
  const interval = 60 / bpm;
  const expectedBeats: number[] = [];
  for (let t = 0.5; t < durationSec - 0.05; t += interval) {
    expectedBeats.push(t);
    const i0 = Math.floor(t * sampleRate);
    // Short decaying low-frequency burst (~80 Hz) for spectral flux
    for (let k = 0; k < Math.floor(sampleRate * 0.04); k++) {
      const i = i0 + k;
      if (i >= n) break;
      const env = Math.exp(-k / (sampleRate * 0.008));
      pcm[i] = env * Math.sin((2 * Math.PI * 80 * k) / sampleRate);
    }
  }
  return { pcm, expectedBeats };
}

function meanAbsError(detected: number[], expected: number[]): number {
  const errors: number[] = [];
  for (const e of expected) {
    let best = Infinity;
    for (const d of detected) {
      best = Math.min(best, Math.abs(d - e));
    }
    errors.push(best);
  }
  return errors.reduce((a, b) => a + b, 0) / errors.length;
}

describe('audioAnalysis WASM', () => {
  beforeEach(() => {
    _resetAudioAnalysisLoadStateForTests();
  });

  it('loads and analyzes a frame into 8 bands', async () => {
    const analyzer = await createAudioAnalyzer(44100, 2048, { baseUrl: WASM_BASE });
    expect(analyzer.available).toBe(true);
    if (!analyzer.available) return;

    const pcm = new Float32Array(2048);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.sin((2 * Math.PI * 110 * i) / 44100);
    }
    const result = analyzer.analyze(pcm);
    expect(result.bands).toHaveLength(8);
    expect(result.bass + result.mid + result.treble).toBeGreaterThan(0);
    analyzer.destroy();
  });

  it('detects 120 BPM clicks within ±50 ms mean error', async () => {
    const sampleRate = 44100;
    const { pcm, expectedBeats } = makeClickTrack(sampleRate, 8, 120);
    const analyzer = await createAudioAnalyzer(sampleRate, 2048, { baseUrl: WASM_BASE });
    expect(analyzer.available).toBe(true);
    if (!analyzer.available) return;

    const offline = analyzePcmWithHandle(analyzer, pcm, {
      beatPeakThreshold: 0.7,
    });
    analyzer.destroy();

    expect(offline.available).toBe(true);
    expect(offline.beatTimestamps.length).toBeGreaterThanOrEqual(expectedBeats.length - 2);

    const mae = meanAbsError(offline.beatTimestamps, expectedBeats);
    expect(mae).toBeLessThanOrEqual(0.05);

    if (offline.bpmEstimate != null) {
      expect(Math.abs(offline.bpmEstimate - 120)).toBeLessThan(8);
    }
  });

  it('packs WebGPU uniform floats', () => {
    const u = toAudioReactiveUniforms({
      bands: new Float32Array(8),
      beat: 0.5,
      bass: 0.1,
      mid: 0.2,
      treble: 0.3,
    });
    expect(u).toHaveLength(4);
    expect(u[0]).toBeCloseTo(0.1, 5);
    expect(u[1]).toBeCloseTo(0.2, 5);
    expect(u[2]).toBeCloseTo(0.3, 5);
    expect(u[3]).toBeCloseTo(0.5, 5);
  });

  it('returns unavailable when baseUrl is bogus (no crash)', async () => {
    _resetAudioAnalysisLoadStateForTests();
    const analyzer = await createAudioAnalyzer(44100, 2048, {
      baseUrl: 'file:///nonexistent-wasm-dir/',
    });
    expect(analyzer.available).toBe(false);
    if (analyzer.available) return;
    expect(analyzer.reason.length).toBeGreaterThan(0);
  });
});
