/**
 * Main-thread proxy around the audio analysis worker.
 */

import type { AudioBandEnergies } from './audioAnalysis';
import type { OfflineAnalysisResult } from './offlineAnalysis';
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from './audioAnalysisWorker';

type Pending = {
  resolve: (value: AnalysisWorkerResponse) => void;
  reject: (err: Error) => void;
};

export class AudioAnalysisWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private failedReason: string | null = null;

  get available(): boolean {
    return this.failedReason == null && this.worker != null;
  }

  get failureReason(): string | null {
    return this.failedReason;
  }

  /**
   * Spawn the worker. Safe to call multiple times.
   * Returns false when Worker construction fails (feature disabled).
   */
  start(): boolean {
    if (this.worker) return true;
    try {
      this.worker = new Worker(new URL('./audioAnalysisWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (ev: MessageEvent<AnalysisWorkerResponse>) => {
        const msg = ev.data;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        p.resolve(msg);
      };
      this.worker.onerror = (err) => {
        this.failedReason = err.message || 'Worker error';
        for (const [, p] of this.pending) {
          p.reject(new Error(this.failedReason!));
        }
        this.pending.clear();
      };
      return true;
    } catch (err) {
      this.failedReason = (err as Error)?.message || String(err);
      this.worker = null;
      return false;
    }
  }

  private post(msg: AnalysisWorkerRequest, transfer?: Transferable[]): Promise<AnalysisWorkerResponse> {
    if (!this.worker) {
      return Promise.reject(new Error(this.failedReason || 'Worker not started'));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      this.worker!.postMessage(msg, transfer ?? []);
    });
  }

  async init(sampleRate: number, fftSize = 2048, baseUrl?: string): Promise<boolean> {
    if (!this.start()) return false;
    const id = this.nextId++;
    const resp = await this.post({ type: 'init', id, sampleRate, fftSize, baseUrl });
    if (resp.type === 'unavailable') {
      this.failedReason = resp.reason;
      return false;
    }
    return resp.type === 'ready';
  }

  async analyzeOffline(
    pcm: Float32Array,
    sampleRate: number,
    fftSize = 2048,
    baseUrl?: string,
  ): Promise<OfflineAnalysisResult> {
    if (!this.start()) {
      return {
        available: false,
        reason: this.failedReason || 'Worker unavailable',
        beatTimestamps: [],
        sampleRate,
        durationSec: pcm.length / sampleRate,
      };
    }
    const id = this.nextId++;
    const copy = pcm.slice();
    const resp = await this.post(
      { type: 'analyzeOffline', id, pcm: copy, sampleRate, fftSize, baseUrl },
      [copy.buffer],
    );
    if (resp.type === 'offlineResult') return resp.result;
    if (resp.type === 'error') {
      return {
        available: false,
        reason: resp.message,
        beatTimestamps: [],
        sampleRate,
        durationSec: pcm.length / sampleRate,
      };
    }
    return {
      available: false,
      reason: 'Unexpected worker response',
      beatTimestamps: [],
      sampleRate,
      durationSec: pcm.length / sampleRate,
    };
  }

  async analyzeFrame(pcm: Float32Array): Promise<AudioBandEnergies | null> {
    if (!this.worker || this.failedReason) return null;
    const id = this.nextId++;
    const copy = pcm.slice();
    const resp = await this.post({ type: 'analyzeFrame', id, pcm: copy }, [copy.buffer]);
    if (resp.type === 'frameResult') return resp.energies;
    return null;
  }

  reset(): void {
    if (!this.worker) return;
    const id = this.nextId++;
    void this.post({ type: 'reset', id });
  }

  destroy(): void {
    if (this.worker) {
      const id = this.nextId++;
      try {
        this.worker.postMessage({ type: 'destroy', id } satisfies AnalysisWorkerRequest);
      } catch {
        /* ignore */
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
  }
}
