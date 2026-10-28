/**
 * Shared "object URL → offline beat analysis" path.
 *
 * Both the clip analysis hook and the master-audio analysis hook decode the
 * media with Web Audio, mix it to mono and push the PCM through the WASM
 * analyzer — preferring a worker so a long song does not stall the UI thread,
 * falling back to main-thread analysis when Workers are unavailable.
 *
 * A single {@link MediaBeatAnalyzer} owns one AudioContext and one worker, so
 * repeated analyses reuse both instead of respawning per file.
 */

import { decodeAudioBuffer } from '../utils/waveform';
import { AudioAnalysisWorkerClient } from './audioAnalysisClient';
import { analyzeAudioBuffer, type OfflineAnalysisResult } from './offlineAnalysis';

/** Downmix every channel to a single Float32Array (WASM analyzer input). */
export function mixToMono(buffer: AudioBuffer): Float32Array {
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

function unavailable(reason: string): OfflineAnalysisResult {
  return {
    available: false,
    reason,
    beatTimestamps: [],
    sampleRate: 0,
    durationSec: 0,
  };
}

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

export class MediaBeatAnalyzer {
  private ctx: AudioContext | null = null;
  private client: AudioAnalysisWorkerClient | null = null;
  private clientTried = false;

  /**
   * Decode and analyze one media object URL.
   * Never throws for missing browser support — returns `available: false`.
   */
  async analyze(objectUrl: string): Promise<OfflineAnalysisResult> {
    if (!objectUrl) return unavailable('No media URL');

    const Ctx = audioContextCtor();
    if (!Ctx) return unavailable('Web Audio unavailable');

    if (!this.ctx) {
      try {
        this.ctx = new Ctx();
      } catch (err) {
        return unavailable((err as Error)?.message || 'AudioContext failed');
      }
    }

    const buffer = await decodeAudioBuffer(objectUrl, this.ctx);

    if (!this.clientTried) {
      this.clientTried = true;
      const client = new AudioAnalysisWorkerClient();
      if (client.start()) this.client = client;
    }

    if (this.client?.available) {
      const pcm = mixToMono(buffer);
      return this.client.analyzeOffline(pcm, buffer.sampleRate);
    }
    return analyzeAudioBuffer(buffer);
  }

  destroy(): void {
    this.client?.destroy();
    this.client = null;
    this.clientTried = false;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      void ctx.close().catch(() => {
        /* already closed */
      });
    }
  }
}
