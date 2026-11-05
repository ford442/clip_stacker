/**
 * Export premix worker: runs `openTimelineMixStream` (the media-engine mix
 * and, with lane FX, the bus session) off the main thread. Decoding stays on
 * main (workers have no `OfflineAudioContext`), so the stream's PCM provider
 * asks main for each clip's PCM when the entry first falls inside a chunk;
 * mixed chunks go back one `pull` at a time (main keeps one in flight while
 * it encodes the last). Protocol: `audioRenderProtocol.ts`.
 */

import type { RenderWorkerRequest, RenderWorkerResponse } from './audioRenderProtocol';
import {
  openTimelineMixStream,
  type ClipPcm,
  type ClipPcmProvider,
  type TimelineMixStream,
} from '../wasm/mediaEngine';

type Post = (message: RenderWorkerResponse, transfer?: Transferable[]) => void;

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

/** The worker's message handling, separate from `onmessage` so tests drive it in-process. */
export class AudioRenderWorkerCore {
  private readonly streams = new Map<number, StreamState>();

  constructor(private readonly post: Post) {}

  handle(msg: RenderWorkerRequest): void {
    switch (msg.type) {
      case 'open':
        void this.open(msg.id, msg);
        return;
      case 'pull': {
        const state = this.streams.get(msg.id);
        if (!state) return;
        state.queue = state.queue.then(() => this.pull(msg.id, state));
        return;
      }
      case 'pcm-begin': {
        const pending = this.streams.get(msg.id)?.pcm.get(msg.index);
        if (!pending) return;
        pending.pcm = {
          sampleRate: msg.sampleRate,
          channelData: Array.from({ length: msg.channels }, () => new Float32Array(msg.frames)),
        };
        return;
      }
      case 'pcm-part': {
        const pending = this.streams.get(msg.id)?.pcm.get(msg.index);
        pending?.pcm?.channelData[msg.channel]?.set(msg.data, msg.offset);
        return;
      }
      case 'pcm-end': {
        const state = this.streams.get(msg.id);
        const pending = state?.pcm.get(msg.index);
        if (!state || !pending) return;
        state.pcm.delete(msg.index);
        pending.resolve(pending.pcm);
        return;
      }
      case 'pcm-error': {
        const state = this.streams.get(msg.id);
        const pending = state?.pcm.get(msg.index);
        if (!state || !pending) return;
        state.pcm.delete(msg.index);
        if (msg.skip) pending.resolve(null);
        else pending.reject(new Error(msg.message));
        return;
      }
      case 'close':
        this.close(msg.id);
        return;
    }
  }

  private async open(id: number, msg: Extract<RenderWorkerRequest, { type: 'open' }>): Promise<void> {
    const state: StreamState = { stream: null, pcm: new Map(), closed: false, queue: Promise.resolve() };
    this.streams.set(id, state);
    const provider: ClipPcmProvider = {
      acquire: (index) =>
        new Promise<ClipPcm | null>((resolve, reject) => {
          if (state.closed) {
            reject(new Error('mix stream closed'));
            return;
          }
          state.pcm.set(index, { resolve, reject, pcm: null });
          this.post({ type: 'need-pcm', id, index });
        }),
      release: (index) => {
        if (!state.closed) this.post({ type: 'release', id, index });
      },
    };
    let stream: TimelineMixStream | null;
    try {
      stream = await openTimelineMixStream(msg.entries, provider, msg.options);
    } catch (err) {
      this.fail(id, err);
      return;
    }
    if (state.closed) {
      stream?.close();
      return;
    }
    if (!stream) {
      this.streams.delete(id);
      this.post({ type: 'unavailable', id });
      return;
    }
    state.stream = stream;
    this.post({
      type: 'opened',
      id,
      totalFrames: stream.totalFrames,
      sampleRate: stream.sampleRate,
      channels: stream.channels,
    });
  }

  private async pull(id: number, state: StreamState): Promise<void> {
    const stream = state.stream;
    if (state.closed || !stream) return;
    try {
      const chunk = await stream.next();
      if (state.closed) return;
      if (!chunk) {
        this.post({ type: 'done', id, meters: stream.readMeters() });
        return;
      }
      // The stream reuses its chunk buffer: send a copy, by transfer.
      const frames = chunk.frames.slice();
      this.post(
        { type: 'chunk', id, startFrame: chunk.startFrame, frameCount: chunk.frameCount, frames },
        [frames.buffer],
      );
    } catch (err) {
      this.fail(id, err);
    }
  }

  private fail(id: number, err: unknown): void {
    if (this.streams.get(id)?.closed) return;
    this.post({ type: 'error', id, message: (err as Error)?.message || String(err) });
    this.close(id);
  }

  private close(id: number): void {
    const state = this.streams.get(id);
    if (!state) return;
    state.closed = true;
    this.streams.delete(id);
    for (const pending of state.pcm.values()) pending.reject(new Error('mix stream closed'));
    state.pcm.clear();
    state.stream?.close();
  }
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent<RenderWorkerRequest>) => void) | null;
  postMessage(message: RenderWorkerResponse, transfer: Transferable[]): void;
  document?: unknown;
}

const scope = globalThis as unknown as WorkerScope;
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function') {
  const core = new AudioRenderWorkerCore((message, transfer) => scope.postMessage(message, transfer ?? []));
  scope.onmessage = (ev) => core.handle(ev.data);
}
