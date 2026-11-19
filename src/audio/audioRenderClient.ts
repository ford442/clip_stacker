/**
 * Main-thread side of the export premix worker. `openMixStream` has the
 * shape of `openTimelineMixStream` but runs the mix (media engine, bus
 * session, meter) in `audioRender.worker.ts`: main posts the schedule,
 * answers the worker's PCM requests from its provider (decoding stays here)
 * in slices, and gets mixed chunks back while it encodes. Without Worker
 * support, or after the worker fails to start, the mix runs in this realm
 * exactly as before. Null = the media engine is off or unavailable.
 */

import {
  MEDIA_ENGINE_RESAMPLER_PARAM,
  isMediaEngineMixEnabled,
  openTimelineMixStream,
  type ClipPcmProvider,
  type MediaEngineMixEntry,
  type MixMeterReading,
  type TapMeterReading,
  type TimelineMixChunk,
  type TimelineMixStreamOptions,
} from '../wasm/mediaEngine';
import { getWasmPublicBaseUrl } from '../wasm/emscriptenLoader';
import { createAudioRenderWorker } from '../workers/workerFactories';
import { createWorkerClient, type WorkerClient, type WorkerLike } from '../workers/workerRpc';
import { PCM_PART_FRAMES, type AudioRenderProtocol, type RenderPullResult } from './audioRenderProtocol';

/** What export needs of a mix stream, wherever it runs. */
export interface MixStream extends AsyncIterable<TimelineMixChunk> {
  readonly totalFrames: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** The output meter (`meter` option); read after the last chunk. */
  readMeters(): MixMeterReading | null;
  /** Per-tap loudness (`meterTaps` option), in tap order; read after the last chunk. */
  readTapMeters(): TapMeterReading[] | null;
  close(): void;
}

type WorkerFactory = () => WorkerLike;
type RenderClient = WorkerClient<AudioRenderProtocol>;

const defaultFactory = (): WorkerFactory | null => (typeof Worker === 'undefined' ? null : createAudioRenderWorker);

let factory: WorkerFactory | null = defaultFactory();
let client: RenderClient | null = null;
let nextId = 1;
const streams = new Map<number, WorkerMixStream>();

/** Yield to the event loop between PCM slices, so a long clip's copy is many short tasks. */
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function workerClient(): RenderClient | null {
  if (!factory) return null;
  if (!client) {
    const c = createWorkerClient<AudioRenderProtocol>(factory, {
      name: 'audio render',
      // A worker that dies mid-export fails its streams; export falls back.
      onCrash: (err) => {
        console.warn(`[audioRender] ${err.message}`);
        for (const stream of streams.values()) stream.fail(err);
        streams.clear();
      },
    });
    c.on('need-pcm', ({ id, index }) => streams.get(id)?.needPcm(index));
    c.on('release', ({ id, index }) => streams.get(id)?.release(index));
    if (!c.start()) console.warn('[audioRender] cannot start the worker; mixing on this thread', c.failure);
    client = c;
  }
  return client.available ? client : null;
}

/** `?media_engine_resampler=linear` is a page parameter; the worker cannot see it. */
function pageResampler(): 'linear' | 'polyphase' {
  const search = typeof location !== 'undefined' ? location.search : '';
  return new URLSearchParams(search.replace(/^\?/, '')).get(MEDIA_ENGINE_RESAMPLER_PARAM) === 'linear'
    ? 'linear'
    : 'polyphase';
}

type Settled = { result: RenderPullResult } | { error: unknown };

class WorkerMixStream implements MixStream {
  totalFrames = 0;
  sampleRate = 0;
  channels = 0;
  private meters: MixMeterReading | null = null;
  private tapMeters: TapMeterReading[] | null = null;
  private closed = false;
  private finished = false;
  /** Pulls in flight, in order; each settles (never rejects). */
  private readonly inflight: Promise<Settled>[] = [];
  /** Settles when the stream fails on this side (a post failed, the worker died). */
  private readonly failed: Promise<Settled>;
  private failWith: (value: Settled) => void = () => {};
  private failure: unknown = null;
  /** Entries whose PCM the worker asked for and has not released. */
  private readonly held = new Set<number>();

  constructor(
    readonly id: number,
    private readonly rpc: RenderClient,
    private readonly provider: ClipPcmProvider,
  ) {
    this.failed = new Promise((resolve) => {
      this.failWith = resolve;
    });
  }

  async open(entries: MediaEngineMixEntry[], options: TimelineMixStreamOptions): Promise<boolean> {
    try {
      const dims = await this.rpc.call('open', { id: this.id, entries, options });
      if (!dims) return false;
      this.totalFrames = dims.totalFrames;
      this.sampleRate = dims.sampleRate;
      this.channels = dims.channels;
      return true;
    } catch {
      // Failed before it opened: no stream (callers fall back).
      return false;
    }
  }

  needPcm(index: number): void {
    if (this.closed) return;
    this.held.add(index);
    void this.sendPcm(index);
  }

  release(index: number): void {
    if (!this.closed && this.held.delete(index)) this.provider.release?.(index);
  }

  fail(err: unknown): void {
    if (this.closed || this.failure) return;
    this.failure = err;
    this.failWith({ error: err });
  }

  readMeters(): MixMeterReading | null {
    return this.closed ? null : this.meters;
  }

  readTapMeters(): TapMeterReading[] | null {
    return this.closed ? null : this.tapMeters;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TimelineMixChunk> {
    while (!this.finished) {
      if (this.closed) throw new Error('mix stream is closed');
      // Keep one pull ahead: the worker mixes chunk k + 1 while we encode k.
      while (this.inflight.length < 2) this.inflight.push(this.pull());
      const next = await Promise.race([this.inflight.shift()!, this.failed]);
      if ('error' in next) throw next.error;
      const result = next.result;
      if (result.type === 'done') {
        this.finished = true;
        this.meters = result.meters;
        this.tapMeters = result.tapMeters;
        return;
      }
      const { startFrame, frameCount, frames, taps } = result;
      yield taps ? { startFrame, frameCount, frames, taps } : { startFrame, frameCount, frames };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    streams.delete(this.id);
    // As the in-realm stream does on close: release every PCM still held.
    for (const index of this.held) this.provider.release?.(index);
    this.held.clear();
    try {
      this.rpc.notify('close', { id: this.id });
    } catch {
      // The worker is gone; nothing to close.
    }
  }

  private pull(): Promise<Settled> {
    return this.rpc.call('pull', { id: this.id }).then(
      (result): Settled => ({ result }),
      (error: unknown): Settled => ({ error }),
    );
  }

  /** Answer `need-pcm`: decode on this thread, then send the planes in slices. */
  private async sendPcm(index: number): Promise<void> {
    const id = this.id;
    try {
      let pcm;
      try {
        pcm = await this.provider.acquire(index);
      } catch (err) {
        this.rpc.notify('pcm-error', { id, index, message: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (this.closed) return;
      if (!pcm || pcm.channelData.length === 0 || !(pcm.sampleRate > 0)) {
        this.rpc.notify('pcm-error', { id, index, message: 'no audio', skip: true });
        return;
      }
      const planes = pcm.channelData.slice(0, 2);
      const frames = planes[0]?.length ?? 0;
      this.rpc.notify('pcm-begin', { id, index, sampleRate: pcm.sampleRate, channels: planes.length, frames });
      for (let offset = 0; offset < frames; offset += PCM_PART_FRAMES) {
        for (let channel = 0; channel < planes.length; channel++) {
          if (this.closed) return;
          // A copy: the planes are AudioBuffer views (or a cache's), never ours to transfer.
          const data = planes[channel]!.slice(offset, Math.min(frames, offset + PCM_PART_FRAMES));
          this.rpc.notify('pcm-part', { id, index, channel, offset, data }, { transfer: [data.buffer] });
        }
        if (offset + PCM_PART_FRAMES < frames) await yieldTask();
      }
      if (!this.closed) this.rpc.notify('pcm-end', { id, index });
    } catch (err) {
      // A post failed: the worker will never get this PCM.
      this.fail(err);
    }
  }
}

/**
 * Open the export mix of `entries` — in the render worker when there is
 * one. Null when the media engine is disabled or unavailable (callers fall
 * back to OfflineAudioContext). PCM comes from `provider`, on this thread.
 */
export async function openMixStream(
  entries: MediaEngineMixEntry[],
  provider: ClipPcmProvider,
  options: TimelineMixStreamOptions,
): Promise<MixStream | null> {
  if (!isMediaEngineMixEnabled()) return openTimelineMixStream(entries, provider, options);
  const rpc = workerClient();
  if (!rpc) return openTimelineMixStream(entries, provider, options);
  const id = nextId++;
  const stream = new WorkerMixStream(id, rpc, provider);
  streams.set(id, stream);
  const ok = await stream.open(entries, {
    ...options,
    resampler: options.resampler ?? pageResampler(),
    baseUrl: options.baseUrl ?? getWasmPublicBaseUrl(),
  });
  if (!ok) {
    stream.close();
    return null;
  }
  return stream;
}

/** Test-only: swap the worker factory (null = no Worker support) and forget the worker. */
export function __setAudioRenderWorkerFactoryForTests(next: WorkerFactory | null | undefined): void {
  client?.terminate();
  client = null;
  streams.clear();
  factory = next === undefined ? defaultFactory() : next;
}
