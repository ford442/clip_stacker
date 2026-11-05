/**
 * Messages between the export premix client (`audioRenderClient.ts`, main
 * thread) and `audioRender.worker.ts`. Every message names its stream, so
 * one worker can run the metering pass and the final pass back to back.
 *
 * - main → worker: `open`, then `pull` per chunk; PCM in answer to
 *   `need-pcm` as `pcm-begin`, `pcm-part`s (one channel slice each,
 *   transferred) and `pcm-end`, or `pcm-error`; `close` at the end.
 * - worker → main: `opened`, `need-pcm` / `release` (the stream's
 *   `ClipPcmProvider` calls), `chunk` (interleaved, transferred), `done`
 *   with the output meter, or `error`.
 */

import type { MediaEngineMixEntry, MixMeterReading, TimelineMixStreamOptions } from '../wasm/mediaEngine';

export type RenderWorkerRequest =
  | {
      type: 'open';
      id: number;
      entries: MediaEngineMixEntry[];
      options: TimelineMixStreamOptions;
    }
  | { type: 'pull'; id: number }
  | { type: 'pcm-begin'; id: number; index: number; sampleRate: number; channels: number; frames: number }
  | { type: 'pcm-part'; id: number; index: number; channel: number; offset: number; data: Float32Array }
  | { type: 'pcm-end'; id: number; index: number }
  | { type: 'pcm-error'; id: number; index: number; message: string; skip?: boolean }
  | { type: 'close'; id: number };

export type RenderWorkerResponse =
  | { type: 'opened'; id: number; totalFrames: number; sampleRate: number; channels: number }
  | { type: 'unavailable'; id: number }
  | { type: 'need-pcm'; id: number; index: number }
  | { type: 'release'; id: number; index: number }
  | { type: 'chunk'; id: number; startFrame: number; frameCount: number; frames: Float32Array }
  | { type: 'done'; id: number; meters: MixMeterReading | null }
  | { type: 'error'; id: number; message: string };

/** Frames per `pcm-part`: 1 Mi floats (4 MB) per copy, well under a 50 ms task. */
export const PCM_PART_FRAMES = 1 << 20;
