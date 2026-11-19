/**
 * Dedicated worker running Whisper transcription.
 *
 * `whisperTranscribe` is a blocking WASM call measured in seconds to minutes;
 * on the main thread it would freeze the editor and make cancellation
 * impossible. In a worker the UI keeps painting, progress arrives as events,
 * and cancel is the call's abort signal, which the wrapper's progress
 * callback reads. Served through the worker RPC (`src/workers/workerRpc.ts`).
 */

import type { TranscriptSegment } from '../captions/captionSegments';
import { fetchModel } from './whisperModelCache';
import { withHeap } from './emscriptenLoader';
import { allocString, loadWhisperModule, type WhisperModule } from './whisperModule';
import { exposeWorker } from '../workers/workerRpc';

export interface WhisperTranscribeRequest {
  pcm: Float32Array;
  modelUrl: string;
  language?: string | undefined;
  threads?: number | undefined;
  baseUrl?: string | undefined;
}

export type WhisperProtocol = {
  /** Rejects with an `AbortError` when cancelled (abort the call). */
  transcribe: { req: WhisperTranscribeRequest; res: TranscriptSegment[] };
  progress: { event: { progress: number | null; stage: string } };
};

const cancelledError = () => new DOMException('Transcription cancelled', 'AbortError');

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

async function transcribe(
  request: WhisperTranscribeRequest,
  signal: AbortSignal,
  progress: (progress: number | null, stage: string) => void,
): Promise<TranscriptSegment[]> {
  const { pcm, modelUrl, language, threads, baseUrl } = request;

  progress(null, 'Loading speech model…');
  const module = await loadWhisperModule(baseUrl === undefined ? {} : { baseUrl });
  if (!module) throw new Error('Whisper WASM module is not available.');

  const modelBytes = await fetchModel(modelUrl, {
    onProgress: (fraction) => progress(fraction, 'Downloading speech model…'),
  });
  if (signal.aborted) throw cancelledError();

  // The model is copied into the heap only for `whisperInit`, which keeps
  // its own copy of the weights.
  const handle = withHeap(module, (heap) => module._whisperInit(heap.u8(modelBytes), modelBytes.length));
  if (handle === null) throw new Error('Not enough memory to load the speech model.');
  if (!handle) throw new Error('Whisper could not load the model file.');

  // The wrapper calls this from inside the blocking run; a non-zero return
  // aborts it, which is the only way cancel can interrupt a WASM call.
  module.onWhisperProgress = (fraction: number) => {
    if (signal.aborted) return 1;
    progress(fraction, 'Transcribing…');
    return 0;
  };

  try {
    const count = withHeap(module, (heap) =>
      module._whisperTranscribe(
        handle,
        heap.f32(pcm),
        pcm.length,
        allocString(module, heap, language && language.length > 0 ? language : 'auto'),
        threads ?? 0,
      ),
    );
    if (signal.aborted) throw cancelledError();
    if (count === null) throw new Error('Not enough memory for this much audio.');
    if (count < 0) throw new Error(`Whisper failed (code ${count}).`);
    return readSegments(module, handle, count);
  } finally {
    delete module.onWhisperProgress;
    module._whisperFree(handle);
  }
}

exposeWorker<WhisperProtocol>((port) => ({
  transcribe: (request, ctx) =>
    transcribe(request, ctx.signal, (progress, stage) => port.emit('progress', { progress, stage })),
}));
