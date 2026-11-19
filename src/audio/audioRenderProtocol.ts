/**
 * The export premix worker's protocol (`audioRenderClient.ts` on main,
 * `audioRender.worker.ts`), served through the worker RPC
 * (`src/workers/workerRpc.ts`). Every payload names its stream, so one
 * worker can run the metering pass and the final pass back to back.
 *
 * - calls: `open` (null = the media engine is unavailable there), then one
 *   `pull` per chunk (a `chunk`, interleaved and transferred with its output
 *   taps, or `done` with the output meter and the tap meters). A failed mix
 *   rejects the pull.
 * - stream channel, worker → main: `need-pcm` / `release` (the stream's
 *   `ClipPcmProvider` calls); main → worker: the PCM in answer, as
 *   `pcm-begin`, `pcm-part`s (one channel slice each, transferred) and
 *   `pcm-end`, or `pcm-error`; `close` at the end.
 */

import type {
  MediaEngineMixEntry,
  MixMeterReading,
  TapMeterReading,
  TimelineMixStreamOptions,
} from '../wasm/mediaEngine';

export interface RenderStreamDims {
  totalFrames: number;
  sampleRate: number;
  channels: number;
}

export type RenderPullResult =
  | {
      type: 'chunk';
      id: number;
      startFrame: number;
      frameCount: number;
      frames: Float32Array;
      /** `TimelineMixChunk.taps`, one transferred block per tap. */
      taps?: Float32Array[];
    }
  | { type: 'done'; id: number; meters: MixMeterReading | null; tapMeters: TapMeterReading[] | null };

export type AudioRenderProtocol = {
  open: {
    req: { id: number; entries: MediaEngineMixEntry[]; options: TimelineMixStreamOptions };
    res: RenderStreamDims | null;
  };
  pull: { req: { id: number }; res: RenderPullResult };
  close: { notify: { id: number } };
  'pcm-begin': { notify: { id: number; index: number; sampleRate: number; channels: number; frames: number } };
  'pcm-part': { notify: { id: number; index: number; channel: number; offset: number; data: Float32Array } };
  'pcm-end': { notify: { id: number; index: number } };
  'pcm-error': { notify: { id: number; index: number; message: string; skip?: boolean } };
  'need-pcm': { event: { id: number; index: number } };
  release: { event: { id: number; index: number } };
};

/** Frames per `pcm-part`: 1 Mi floats (4 MB) per copy, well under a 50 ms task. */
export const PCM_PART_FRAMES = 1 << 20;
