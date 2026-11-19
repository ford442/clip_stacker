/**
 * Export premix worker: runs `openTimelineMixStream` (the media-engine mix
 * and, with lane FX, the bus session) off the main thread. Decoding stays on
 * main (workers have no `OfflineAudioContext`), so the stream's PCM provider
 * asks main for each clip's PCM when the entry first falls inside a chunk;
 * mixed chunks go back one `pull` at a time (main keeps one in flight while
 * it encodes the last). Protocol: `audioRenderProtocol.ts`.
 */

import type { AudioRenderProtocol, RenderPullResult } from './audioRenderProtocol';
import {
  openTimelineMixStream,
  type ClipPcm,
  type ClipPcmProvider,
  type TimelineMixStream,
} from '../wasm/mediaEngine';
import { exposeWorker, withTransfer, type TransferReply, type WorkerHandlers, type WorkerPort } from '../workers/workerRpc';

interface PendingPcm {
  resolve: (pcm: ClipPcm | null) => void;
  reject: (err: Error) => void;
  pcm: ClipPcm | null;
}

interface StreamState {
  stream: TimelineMixStream | null;
  pcm: Map<number, PendingPcm>;
  closed: boolean;
  /** Pulls run one after another, in arrival order. */
  queue: Promise<void>;
}

const closedError = () => new Error('mix stream closed');

/** The worker's handlers, separate from the scope so tests serve them in-process. */
export function createAudioRenderHandlers(port: WorkerPort<AudioRenderProtocol>): WorkerHandlers<AudioRenderProtocol> {
  const streams = new Map<number, StreamState>();

  const close = (id: number) => {
    const state = streams.get(id);
    if (!state) return;
    state.closed = true;
    streams.delete(id);
    for (const pending of state.pcm.values()) pending.reject(closedError());
    state.pcm.clear();
    state.stream?.close();
  };

  const pendingPcm = (id: number, index: number) => streams.get(id)?.pcm.get(index);

  const settlePcm = (id: number, index: number, settle: (pending: PendingPcm) => void) => {
    const state = streams.get(id);
    const pending = state?.pcm.get(index);
    if (!state || !pending) return;
    state.pcm.delete(index);
    settle(pending);
  };

  const pullOnce = async (id: number, state: StreamState): Promise<RenderPullResult | TransferReply<RenderPullResult>> => {
    const stream = state.stream;
    if (state.closed || !stream) throw closedError();
    try {
      const chunk = await stream.next();
      if (state.closed) throw closedError();
      if (!chunk) return { type: 'done', id, meters: stream.readMeters() };
      // The stream reuses its chunk buffer: send a copy, by transfer.
      const frames = chunk.frames.slice();
      return withTransfer<RenderPullResult>(
        { type: 'chunk', id, startFrame: chunk.startFrame, frameCount: chunk.frameCount, frames },
        [frames.buffer],
      );
    } catch (err) {
      close(id);
      throw err;
    }
  };

  return {
    open: async ({ id, entries, options }) => {
      const state: StreamState = { stream: null, pcm: new Map(), closed: false, queue: Promise.resolve() };
      streams.set(id, state);
      const provider: ClipPcmProvider = {
        acquire: (index) =>
          new Promise<ClipPcm | null>((resolve, reject) => {
            if (state.closed) {
              reject(closedError());
              return;
            }
            state.pcm.set(index, { resolve, reject, pcm: null });
            port.emit('need-pcm', { id, index });
          }),
        release: (index) => {
          if (!state.closed) port.emit('release', { id, index });
        },
      };
      let stream: TimelineMixStream | null;
      try {
        stream = await openTimelineMixStream(entries, provider, options);
      } catch (err) {
        close(id);
        throw err;
      }
      if (state.closed || !stream) {
        stream?.close();
        streams.delete(id);
        return null;
      }
      state.stream = stream;
      return { totalFrames: stream.totalFrames, sampleRate: stream.sampleRate, channels: stream.channels };
    },

    pull: ({ id }) => {
      const state = streams.get(id);
      if (!state) throw closedError();
      const run = state.queue.then(() => pullOnce(id, state));
      state.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    close: ({ id }) => close(id),

    'pcm-begin': ({ id, index, sampleRate, channels, frames }) => {
      const pending = pendingPcm(id, index);
      if (!pending) return;
      pending.pcm = {
        sampleRate,
        channelData: Array.from({ length: channels }, () => new Float32Array(frames)),
      };
    },

    'pcm-part': ({ id, index, channel, offset, data }) => {
      pendingPcm(id, index)?.pcm?.channelData[channel]?.set(data, offset);
    },

    'pcm-end': ({ id, index }) => settlePcm(id, index, (pending) => pending.resolve(pending.pcm)),

    'pcm-error': ({ id, index, message, skip }) =>
      settlePcm(id, index, (pending) => (skip ? pending.resolve(null) : pending.reject(new Error(message)))),
  };
}

exposeWorker<AudioRenderProtocol>(createAudioRenderHandlers);
