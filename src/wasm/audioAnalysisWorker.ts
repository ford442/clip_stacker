/**
 * Dedicated worker for offline / streaming audio analysis.
 * Keeps FFT off the main thread (pairs with preview worker #145).
 */

import {
  createAudioAnalyzer,
  type AudioAnalyzerHandle,
  type AudioBandEnergies,
} from './audioAnalysis';
import { analyzePcmWithHandle, type OfflineAnalysisResult } from './offlineAnalysis';

export type AnalysisWorkerRequest =
  | {
      type: 'init';
      id: number;
      sampleRate: number;
      fftSize?: number;
      baseUrl?: string;
    }
  | {
      type: 'analyzeOffline';
      id: number;
      pcm: Float32Array;
      sampleRate: number;
      fftSize?: number;
      baseUrl?: string;
      transfer?: boolean;
    }
  | {
      type: 'analyzeFrame';
      id: number;
      pcm: Float32Array;
    }
  | { type: 'reset'; id: number }
  | { type: 'destroy'; id: number };

export type AnalysisWorkerResponse =
  | { type: 'ready'; id: number; hopSize: number }
  | { type: 'unavailable'; id: number; reason: string }
  | { type: 'offlineResult'; id: number; result: OfflineAnalysisResult }
  | { type: 'frameResult'; id: number; energies: AudioBandEnergies }
  | { type: 'error'; id: number; message: string };

let analyzer: AudioAnalyzerHandle | null = null;

async function ensureAnalyzer(
  sampleRate: number,
  fftSize: number,
  baseUrl?: string,
): Promise<AudioAnalyzerHandle | { reason: string }> {
  if (analyzer && analyzer.sampleRate === sampleRate && analyzer.fftSize === fftSize) {
    return analyzer;
  }
  if (analyzer) {
    analyzer.destroy();
    analyzer = null;
  }
  const created = await createAudioAnalyzer(sampleRate, fftSize, { baseUrl });
  if (!created.available) return { reason: created.reason };
  analyzer = created;
  return analyzer;
}

self.onmessage = async (ev: MessageEvent<AnalysisWorkerRequest>) => {
  const msg = ev.data;
  const reply = (data: AnalysisWorkerResponse) => {
    (self as DedicatedWorkerGlobalScope).postMessage(data);
  };

  try {
    switch (msg.type) {
      case 'init': {
        const result = await ensureAnalyzer(
          msg.sampleRate,
          msg.fftSize ?? 2048,
          msg.baseUrl,
        );
        if ('reason' in result) {
          reply({ type: 'unavailable', id: msg.id, reason: result.reason });
        } else {
          reply({ type: 'ready', id: msg.id, hopSize: result.hopSize });
        }
        break;
      }
      case 'analyzeOffline': {
        const result = await ensureAnalyzer(
          msg.sampleRate,
          msg.fftSize ?? 2048,
          msg.baseUrl,
        );
        if ('reason' in result) {
          reply({
            type: 'offlineResult',
            id: msg.id,
            result: {
              available: false,
              reason: result.reason,
              beatTimestamps: [],
              sampleRate: msg.sampleRate,
              durationSec: msg.pcm.length / msg.sampleRate,
            },
          });
          break;
        }
        const offline = analyzePcmWithHandle(result, msg.pcm, {
          fftSize: msg.fftSize,
        });
        reply({ type: 'offlineResult', id: msg.id, result: offline });
        break;
      }
      case 'analyzeFrame': {
        if (!analyzer) {
          reply({ type: 'error', id: msg.id, message: 'Analyzer not initialized' });
          break;
        }
        const energies = analyzer.analyze(msg.pcm);
        reply({ type: 'frameResult', id: msg.id, energies });
        break;
      }
      case 'reset': {
        analyzer?.reset();
        break;
      }
      case 'destroy': {
        analyzer?.destroy();
        analyzer = null;
        break;
      }
      default:
        break;
    }
  } catch (err) {
    reply({
      type: 'error',
      id: (msg as { id: number }).id,
      message: (err as Error)?.message || String(err),
    });
  }
};

export {};
