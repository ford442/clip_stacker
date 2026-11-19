/**
 * Main-thread proxy around the audio analysis worker
 * (`audioAnalysisWorker.ts`, through the worker RPC).
 */

import type { AudioBandEnergies } from './audioAnalysis';
import { getWasmPublicBaseUrl } from './emscriptenLoader';
import type { OfflineAnalysisResult } from './offlineAnalysis';
import type { AudioAnalysisProtocol } from './audioAnalysisWorker';
import { createAudioAnalysisWorker } from '../workers/workerFactories';
import { WorkerCrashedError, createWorkerClient, type WorkerClient } from '../workers/workerRpc';

function unavailableResult(reason: string, pcm: Float32Array, sampleRate: number): OfflineAnalysisResult {
  return {
    available: false,
    reason,
    beatTimestamps: [],
    sampleRate,
    durationSec: pcm.length / sampleRate,
  };
}

export class AudioAnalysisWorkerClient {
  private client: WorkerClient<AudioAnalysisProtocol> | null = null;
  private failedReason: string | null = null;

  get available(): boolean {
    return this.failedReason == null && this.client?.available === true;
  }

  get failureReason(): string | null {
    return this.failedReason ?? this.client?.failure?.message ?? null;
  }

  /**
   * Spawn the worker. Safe to call multiple times.
   * Returns false when Worker construction fails (feature disabled).
   */
  start(): boolean {
    if (this.client?.available) return true;
    if (this.failedReason != null) return false;
    const client = createWorkerClient<AudioAnalysisProtocol>(createAudioAnalysisWorker, {
      name: 'audio analysis',
      onCrash: (err) => {
        this.failedReason = err.detail || err.message;
      },
    });
    if (!client.start()) {
      this.failedReason = client.failure?.detail || client.failure?.message || 'Worker unavailable';
      return false;
    }
    this.client = client;
    return true;
  }

  async init(sampleRate: number, fftSize = 2048, baseUrl?: string): Promise<boolean> {
    if (!this.start() || !this.client) return false;
    const resp = await this.client.call('init', { sampleRate, fftSize, baseUrl: baseUrl ?? getWasmPublicBaseUrl() });
    if (!resp.ok) {
      this.failedReason = resp.reason;
      return false;
    }
    return true;
  }

  async analyzeOffline(
    pcm: Float32Array,
    sampleRate: number,
    fftSize = 2048,
    baseUrl?: string,
  ): Promise<OfflineAnalysisResult> {
    if (!this.start() || !this.client) {
      return unavailableResult(this.failureReason || 'Worker unavailable', pcm, sampleRate);
    }
    const copy = pcm.slice();
    try {
      return await this.client.call(
        'analyzeOffline',
        { pcm: copy, sampleRate, fftSize, baseUrl: baseUrl ?? getWasmPublicBaseUrl() },
        { transfer: [copy.buffer] },
      );
    } catch (err) {
      // A dead worker rejects; an analysis that failed in the worker is "unavailable".
      if (err instanceof WorkerCrashedError) throw err;
      return unavailableResult(err instanceof Error ? err.message : String(err), pcm, sampleRate);
    }
  }

  async analyzeFrame(pcm: Float32Array): Promise<AudioBandEnergies | null> {
    if (!this.client || !this.available) return null;
    const copy = pcm.slice();
    try {
      return await this.client.call('analyzeFrame', { pcm: copy }, { transfer: [copy.buffer] });
    } catch (err) {
      if (err instanceof WorkerCrashedError) throw err;
      return null;
    }
  }

  reset(): void {
    if (this.client?.available) this.client.notify('reset');
  }

  destroy(): void {
    if (this.client) {
      try {
        if (this.client.available) this.client.notify('destroy');
      } catch {
        /* ignore */
      }
      this.client.terminate();
      this.client = null;
    }
  }
}
