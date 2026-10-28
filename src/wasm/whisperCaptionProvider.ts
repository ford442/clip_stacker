/**
 * `CaptionProvider` backed by Whisper compiled to WebAssembly.
 *
 * Everything runs locally: audio never leaves the page, and after the first
 * download the weights live in IndexedDB. Both halves are optional at runtime
 * — no `public/wasm/whisper.js`, or no reachable model file, and
 * `isAvailable()` is false with a one-line reason the Captions tab shows
 * instead of an auto-caption button.
 */

import type {
  CaptionProvider,
  CaptionTranscribeOptions,
} from '../utils/captionProvider';
import type { CaptionEntry } from '../types';
import { segmentsToCaptions } from '../utils/captionSegments';
import { hasCachedModel } from './whisperModelCache';
import { resolveWhisperAssetUrl, WHISPER_GLUE_FILE } from './whisperModule';
import type { WhisperWorkerRequest, WhisperWorkerResponse } from './whisperWorker';

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

async function decodeToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const Ctx =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
          .webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio for transcription.');
  const ctx = new Ctx(1, 1, 48000);
  return ctx.decodeAudioData(await blob.arrayBuffer());
}

/** Spawn the worker and run one transcription on it. */
function runOnWorker(
  pcm: Float32Array,
  options: CaptionTranscribeOptions | undefined,
  modelUrl: string,
): Promise<CaptionEntry[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (err) {
      reject(new Error(`Could not start the transcription worker: ${(err as Error).message}`));
      return;
    }

    const id = 1;
    const finish = (run: () => void) => {
      options?.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      run();
    };
    function onAbort() {
      const cancel: WhisperWorkerRequest = { type: 'cancel', id };
      worker.postMessage(cancel);
      // The worker acknowledges with `cancelled`, but a run that never reaches
      // its next progress callback would hang the UI — reject right away and
      // let `terminate` stop the work.
      finish(() => reject(new DOMException('Transcription cancelled', 'AbortError')));
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<WhisperWorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case 'progress':
          options?.onProgress?.({ progress: message.progress, stage: message.stage });
          break;
        case 'segments':
          finish(() =>
            resolve(
              segmentsToCaptions(message.segments, {
                timeOffsetSec: options?.timeOffsetSec,
              }),
            ),
          );
          break;
        case 'cancelled':
          finish(() => reject(new DOMException('Transcription cancelled', 'AbortError')));
          break;
        case 'error':
          finish(() => reject(new Error(message.message)));
          break;
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'Transcription worker failed')));
    };

    const request: WhisperWorkerRequest = {
      type: 'transcribe',
      id,
      pcm,
      modelUrl,
      language: options?.language,
      threads: config.threads,
      baseUrl: config.baseUrl,
    };
    worker.postMessage(request, [pcm.buffer]);
  });
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
    const { toWhisperPcm } = await import('../utils/autoCaptionAudio');
    const buffer = audio instanceof Blob ? await decodeToAudioBuffer(audio) : audio;
    const pcm = toWhisperPcm(buffer);
    return runOnWorker(pcm, options, whisperModelUrl());
  },
};
