/**
 * Dedicated worker for offline / streaming audio analysis.
 * Keeps FFT off the main thread (pairs with preview worker #145).
 * Served through the worker RPC (`src/workers/workerRpc.ts`).
 */

import {
  createAudioAnalyzer,
  type AudioAnalyzerHandle,
  type AudioBandEnergies,
} from './audioAnalysis';
import { analyzePcmWithHandle, type OfflineAnalysisResult } from './offlineAnalysis';
import { exposeWorker } from '../workers/workerRpc';

export type AudioAnalysisProtocol = {
  init: {
    req: { sampleRate: number; fftSize?: number | undefined; baseUrl?: string | undefined };
    res: { ok: true; hopSize: number } | { ok: false; reason: string };
  };
  analyzeOffline: {
    req: { pcm: Float32Array; sampleRate: number; fftSize?: number | undefined; baseUrl?: string | undefined };
    res: OfflineAnalysisResult;
  };
  /** Rejects until `init` has created an analyzer. */
  analyzeFrame: { req: { pcm: Float32Array }; res: AudioBandEnergies };
  reset: { notify: void };
  destroy: { notify: void };
};

let analyzer: AudioAnalyzerHandle | null = null;

async function ensureAnalyzer(
  sampleRate: number,
  fftSize: number,
  baseUrl: string | undefined,
): Promise<AudioAnalyzerHandle | { reason: string }> {
  if (analyzer && analyzer.sampleRate === sampleRate && analyzer.fftSize === fftSize) {
    return analyzer;
  }
  if (analyzer) {
    analyzer.destroy();
    analyzer = null;
  }
  const created = await createAudioAnalyzer(sampleRate, fftSize, baseUrl === undefined ? {} : { baseUrl });
  if (!created.available) return { reason: created.reason };
  analyzer = created;
  return analyzer;
}

exposeWorker<AudioAnalysisProtocol>({
  init: async ({ sampleRate, fftSize, baseUrl }) => {
    const result = await ensureAnalyzer(sampleRate, fftSize ?? 2048, baseUrl);
    return 'reason' in result ? { ok: false, reason: result.reason } : { ok: true, hopSize: result.hopSize };
  },
  analyzeOffline: async ({ pcm, sampleRate, fftSize, baseUrl }) => {
    const result = await ensureAnalyzer(sampleRate, fftSize ?? 2048, baseUrl);
    if ('reason' in result) {
      return {
        available: false,
        reason: result.reason,
        beatTimestamps: [],
        sampleRate,
        durationSec: pcm.length / sampleRate,
      };
    }
    return analyzePcmWithHandle(result, pcm, fftSize === undefined ? {} : { fftSize });
  },
  analyzeFrame: ({ pcm }) => {
    if (!analyzer) throw new Error('Analyzer not initialized');
    return analyzer.analyze(pcm);
  },
  reset: () => {
    analyzer?.reset();
  },
  destroy: () => {
    analyzer?.destroy();
    analyzer = null;
  },
});
