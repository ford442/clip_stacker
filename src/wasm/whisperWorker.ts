/**
 * Dedicated worker running Whisper transcription.
 *
 * `whisperTranscribe` is a blocking WASM call measured in seconds to minutes;
 * on the main thread it would freeze the editor and make cancellation
 * impossible. In a worker the UI keeps painting, progress arrives as messages,
 * and cancel is a flag the wrapper's progress callback reads.
 */

import type { TranscriptSegment } from '../utils/captionSegments';
import { fetchModel } from './whisperModelCache';
import { allocString, loadWhisperModule, type WhisperModule } from './whisperModule';

export type WhisperWorkerRequest =
  | {
      type: 'transcribe';
      id: number;
      pcm: Float32Array;
      modelUrl: string;
      language?: string;
      threads?: number;
      baseUrl?: string;
    }
  | { type: 'cancel'; id: number };

export type WhisperWorkerResponse =
  | { type: 'progress'; id: number; progress: number | null; stage: string }
  | { type: 'segments'; id: number; segments: TranscriptSegment[] }
  | { type: 'error'; id: number; message: string }
  | { type: 'cancelled'; id: number };

const cancelled = new Set<number>();

function post(message: WhisperWorkerResponse): void {
  (self as unknown as Worker).postMessage(message);
}

function readSegments(module: WhisperModule, handle: number, count: number): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < count; i++) {
    segments.push({
      startSec: module._whisperSegmentStartMs(handle, i) / 1000,
      endSec: module._whisperSegmentEndMs(handle, i) / 1000,
      text: module.UTF8ToString(module._whisperSegmentText(handle, i)),
    });
  }
  return segments;
}

async function transcribe(request: Extract<WhisperWorkerRequest, { type: 'transcribe' }>) {
  const { id, pcm, modelUrl, language, threads, baseUrl } = request;

  post({ type: 'progress', id, progress: null, stage: 'Loading speech model…' });
  const module = await loadWhisperModule({ baseUrl });
  if (!module) {
    post({ type: 'error', id, message: 'Whisper WASM module is not available.' });
    return;
  }

  const modelBytes = await fetchModel(modelUrl, {
    onProgress: (fraction) =>
      post({ type: 'progress', id, progress: fraction, stage: 'Downloading speech model…' }),
  });
  if (cancelled.has(id)) {
    cancelled.delete(id);
    post({ type: 'cancelled', id });
    return;
  }

  const modelPtr = module._malloc(modelBytes.length);
  module.HEAPU8.set(modelBytes, modelPtr);
  const handle = module._whisperInit(modelPtr, modelBytes.length);
  module._free(modelPtr);
  if (!handle) {
    post({ type: 'error', id, message: 'Whisper could not load the model file.' });
    return;
  }

  const pcmPtr = module._malloc(pcm.length * 4);
  module.HEAPF32.set(pcm, pcmPtr >> 2);
  const languagePtr = allocString(module, language && language.length > 0 ? language : 'auto');

  // The wrapper calls this from inside the blocking run; a non-zero return
  // aborts it, which is the only way cancel can interrupt a WASM call.
  module.onWhisperProgress = (progress: number) => {
    if (cancelled.has(id)) return 1;
    post({ type: 'progress', id, progress, stage: 'Transcribing…' });
    return 0;
  };

  try {
    const count = module._whisperTranscribe(handle, pcmPtr, pcm.length, languagePtr, threads ?? 0);
    if (cancelled.has(id)) {
      post({ type: 'cancelled', id });
      return;
    }
    if (count < 0) {
      post({ type: 'error', id, message: `Whisper failed (code ${count}).` });
      return;
    }
    post({ type: 'segments', id, segments: readSegments(module, handle, count) });
  } finally {
    module.onWhisperProgress = undefined;
    cancelled.delete(id);
    module._free(pcmPtr);
    module._free(languagePtr);
    module._whisperFree(handle);
  }
}

self.onmessage = (event: MessageEvent<WhisperWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  void transcribe(request).catch((err: unknown) => {
    post({ type: 'error', id: request.id, message: (err as Error)?.message || String(err) });
  });
};
