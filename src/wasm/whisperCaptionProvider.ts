/**
 * `CaptionProvider` backed by Whisper compiled to WebAssembly.
 *
 * Everything runs locally: audio never leaves the page, and after the first
 * download the weights live in IndexedDB. Both halves are optional at runtime
 * — no `public/wasm/whisper.js`, or no reachable model file, and
 * `isAvailable()` is false with a one-line reason the Captions tab shows
 * instead of an auto-caption button.
 */

import { decodeAudio, DECODE_SAMPLE_RATE } from '../audio/decodeAudio';
import type {
  CaptionProvider,
  CaptionTranscribeOptions,
} from '../captions/captionProvider';
import type { CaptionEntry } from '../types';
import { segmentsToCaptions } from '../captions/captionSegments';
import { hasCachedModel } from './whisperModelCache';
import { resolveWhisperAssetUrl, WHISPER_GLUE_FILE } from './whisperModule';
import type { WhisperProtocol } from './whisperWorker';
import { createWhisperWorker } from '../workers/workerFactories';
import { createWorkerClient } from '../workers/workerRpc';

export const WHISPER_PROVIDER_ID = 'whisper-wasm';

/**
 * Default weights: `tiny` is the only size that reliably fits a browser tab's
 * memory. Anything from `small` up belongs on a server (`whisper-http`).
 */
export const DEFAULT_WHISPER_MODEL_FILE = 'models/ggml-tiny-q5_1.bin';

export interface WhisperProviderConfig {
  /** Absolute or app-relative URL of the ggml weight file. */
  modelUrl?: string;
  /** Directory holding `whisper.js` / `whisper.wasm`. Defaults to `/wasm/`. */
  baseUrl?: string;
  /** Threads for the WASM build; 0 lets the module decide. */
  threads?: number;
}

let config: Required<Pick<WhisperProviderConfig, 'threads'>> & WhisperProviderConfig = {
  threads: 0,
};
let unavailableReason: string | null = null;

export function configureWhisperProvider(next: WhisperProviderConfig): void {
  config = { ...config, ...next };
  unavailableReason = null;
}

/** Why the provider is unusable, for the Captions tab's disabled hint. */
export function getWhisperUnavailableReason(): string | null {
  return unavailableReason;
}

function appUrl(value: string): string {
  const base =
    typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  return new URL(value, base).href;
}

export function whisperModelUrl(): string {
  return appUrl(config.modelUrl ?? DEFAULT_WHISPER_MODEL_FILE);
}

/** True when `url` answers a request without downloading the whole file. */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

function decodeToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  return decodeAudio(blob, { sampleRate: DECODE_SAMPLE_RATE });
}

const cancelled = () => new DOMException('Transcription cancelled', 'AbortError');

/** Spawn a worker, run one transcription on it, and terminate it. */
async function runOnWorker(
  pcm: Float32Array,
  options: CaptionTranscribeOptions | undefined,
  modelUrl: string,
): Promise<CaptionEntry[]> {
  const client = createWorkerClient<WhisperProtocol>(createWhisperWorker, { name: 'transcription' });
  if (!client.start()) {
    throw new Error(`Could not start the transcription worker: ${client.failure?.detail ?? 'unknown error'}`);
  }
  client.on('progress', (update) => options?.onProgress?.(update));
  const signal = options?.signal;
  try {
    const segments = await client.call(
      'transcribe',
      { pcm, modelUrl, language: options?.language, threads: config.threads, baseUrl: config.baseUrl },
      // A run blocked in WASM never reads the cancel: the call rejects at
      // once and `terminate` below stops the work.
      { transfer: [pcm.buffer], signal },
    );
    return segmentsToCaptions(
      segments,
      options?.timeOffsetSec === undefined ? {} : { timeOffsetSec: options.timeOffsetSec },
    );
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw cancelled();
    throw err;
  } finally {
    client.terminate();
  }
}

export const whisperCaptionProvider: CaptionProvider = {
  id: WHISPER_PROVIDER_ID,
  label: 'Whisper (in this browser)',

  async isAvailable(): Promise<boolean> {
    if (typeof Worker === 'undefined') {
      unavailableReason = 'Web Workers are unavailable in this browser.';
      return false;
    }
    const glueUrl = resolveWhisperAssetUrl(WHISPER_GLUE_FILE, config.baseUrl);
    if (!(await reachable(glueUrl))) {
      unavailableReason =
        'The Whisper WASM build is not deployed (public/wasm/whisper.js missing).';
      return false;
    }
    const modelUrl = whisperModelUrl();
    if (!(await hasCachedModel(modelUrl)) && !(await reachable(modelUrl))) {
      unavailableReason = `No speech model at ${modelUrl} and none cached offline.`;
      return false;
    }
    unavailableReason = null;
    return true;
  },

  async transcribe(
    audio: Blob | AudioBuffer,
    options?: CaptionTranscribeOptions,
  ): Promise<CaptionEntry[]> {
    if (options?.signal?.aborted) {
      throw new DOMException('Transcription cancelled', 'AbortError');
    }
    const { toWhisperPcm } = await import('../captions/autoCaptionAudio');
    const buffer = audio instanceof Blob ? await decodeToAudioBuffer(audio) : audio;
    const pcm = toWhisperPcm(buffer);
    return runOnWorker(pcm, options, whisperModelUrl());
  },
};
