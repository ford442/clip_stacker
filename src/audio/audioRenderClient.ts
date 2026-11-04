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
  type TimelineMixChunk,
  type TimelineMixStreamOptions,
} from '../wasm/mediaEngine';
import { getWasmPublicBaseUrl } from '../wasm/emscriptenLoader';
import { PCM_PART_FRAMES, type RenderWorkerRequest, type RenderWorkerResponse } from './audioRenderProtocol';

/** What export needs of a mix stream, wherever it runs. */
export interface MixStream extends AsyncIterable<TimelineMixChunk> {
  readonly totalFrames: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** The output meter (`meter` option); read after the last chunk. */
  readMeters(): MixMeterReading | null;
  close(): void;
}

/** What the client needs of a Worker (tests substitute an in-process one). */
export interface RenderWorkerLike {
  postMessage(message: RenderWorkerRequest, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<RenderWorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  terminate(): void;
}

type WorkerFactory = () => RenderWorkerLike;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./audioRender.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as RenderWorkerLike;

let factory: WorkerFactory | null = typeof Worker === 'undefined' ? null : defaultFactory;
let worker: RenderWorkerLike | null = null;
let workerFailed = false;
let nextId = 1;
const streams = new Map<number, WorkerMixStream>();

/** Yield to the event loop between PCM slices, so a long clip's copy is many short tasks. */
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function failWorker(reason: string): void {
  console.warn(`[audioRender] worker failed (${reason})`);
  workerFailed = true;
  worker?.terminate();
  worker = null;
  for (const stream of streams.values()) stream.fail(new Error(`audio render worker failed: ${reason}`));
  streams.clear();
}

function ensureWorker(): RenderWorkerLike | null {
  if (worker) return worker;
  if (workerFailed || !factory) return null;
  try {
    const w = factory();
    w.onmessage = (ev) => streams.get(ev.data.id)?.receive(ev.data);
    w.onerror = (ev) => failWorker(ev.message || 'worker error');
    worker = w;
    return w;
  } catch (err) {
    workerFailed = true;
    console.warn('[audioRender] cannot start the worker; mixing on this thread', err);
    return null;
  }
}

/** `?media_engine_resampler=linear` is a page parameter; the worker cannot see it. */
function pageResampler(): TimelineMixStreamOptions['resampler'] {
  const search = typeof location !== 'undefined' ? location.search : '';
  return new URLSearchParams(search.replace(/^\?/, '')).get(MEDIA_ENGINE_RESAMPLER_PARAM) === 'linear'
    ? 'linear'
    : 'polyphase';
}

type Settled = { chunk: TimelineMixChunk } | { done: true } | { error: Error };

class WorkerMixStream implements MixStream {
  totalFrames = 0;
  sampleRate = 0;
  channels = 0;
  private meters: MixMeterReading | null = null;
  private closed = false;
  private finished = false;
  private opened: ((ok: boolean) => void) | null = null;
  private failure: Error | null = null;
  /** Responses to pulls, in order, and the reader waiting for the next one. */
  private readonly settled: Settled[] = [];
  private waiter: ((value: Settled) => void) | null = null;
  private pullsInFlight = 0;
  /** Entries whose PCM the worker asked for and has not released. */
  private readonly held = new Set<number>();

  constructor(
    readonly id: number,
    private readonly w: RenderWorkerLike,
    private readonly provider: ClipPcmProvider,
  ) {}

  open(entries: MediaEngineMixEntry[], options: TimelineMixStreamOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.opened = resolve;
      this.send({ type: 'open', id: this.id, entries, options });
    });
  }

  receive(msg: RenderWorkerResponse): void {
    if (this.closed) return;
    switch (msg.type) {
      case 'opened':
        this.totalFrames = msg.totalFrames;
        this.sampleRate = msg.sampleRate;
        this.channels = msg.channels;
        this.opened?.(true);
        this.opened = null;
        return;
      case 'unavailable':
        streams.delete(this.id);
        this.opened?.(false);
        this.opened = null;
        return;
      case 'need-pcm':
        this.held.add(msg.index);
        void this.sendPcm(msg.index);
        return;
      case 'release':
        if (this.held.delete(msg.index)) this.provider.release?.(msg.index);
        return;
      case 'chunk':
        this.settle({ chunk: { startFrame: msg.startFrame, frameCount: msg.frameCount, frames: msg.frames } });
        return;
      case 'done':
        this.meters = msg.meters;
        this.settle({ done: true });
        return;
      case 'error':
        this.fail(new Error(msg.message));
        return;
    }
  }

  fail(err: Error): void {
    if (this.closed) return;
    this.failure = err;
    if (this.opened) {
      // Failed before it opened: no stream (callers fall back).
      this.opened(false);
      this.opened = null;
    }
    this.settle({ error: err });
  }

  readMeters(): MixMeterReading | null {
    return this.closed ? null : this.meters;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TimelineMixChunk> {
    while (!this.finished) {
      // Keep one pull ahead: the worker mixes chunk k + 1 while we encode k.
      while (this.pullsInFlight < 2) this.pull();
      const next = await this.take();
      this.pullsInFlight -= 1;
      if ('error' in next) throw next.error;
      if ('done' in next) {
        this.finished = true;
        return;
      }
      yield next.chunk;
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
      this.w.postMessage({ type: 'close', id: this.id }, []);
    } catch {
      // The worker is gone; nothing to close.
    }
  }

  private pull(): void {
    if (this.closed) throw new Error('mix stream is closed');
    this.pullsInFlight += 1;
    this.send({ type: 'pull', id: this.id });
  }

  private take(): Promise<Settled> {
    const ready = this.settled.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.resolve({ error: this.failure });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private settle(value: Settled): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(value);
    } else {
      this.settled.push(value);
    }
  }

  private send(msg: RenderWorkerRequest, transfer: Transferable[] = []): void {
    try {
      this.w.postMessage(msg, transfer);
    } catch (err) {
      this.fail(err as Error);
    }
  }

  /** Answer `need-pcm`: decode on this thread, then send the planes in slices. */
  private async sendPcm(index: number): Promise<void> {
    const id = this.id;
    let pcm;
    try {
      pcm = await this.provider.acquire(index);
    } catch (err) {
      this.send({ type: 'pcm-error', id, index, message: (err as Error)?.message || String(err) });
      return;
    }
    if (this.closed) return;
    if (!pcm || pcm.channelData.length === 0 || !(pcm.sampleRate > 0)) {
      this.send({ type: 'pcm-error', id, index, message: 'no audio', skip: true });
      return;
    }
    const planes = pcm.channelData.slice(0, 2);
    const frames = planes[0]!.length;
    this.send({ type: 'pcm-begin', id, index, sampleRate: pcm.sampleRate, channels: planes.length, frames });
    for (let offset = 0; offset < frames; offset += PCM_PART_FRAMES) {
      for (let channel = 0; channel < planes.length; channel++) {
        if (this.closed) return;
        // A copy: the planes are AudioBuffer views (or a cache's), never ours to transfer.
        const data = planes[channel]!.slice(offset, Math.min(frames, offset + PCM_PART_FRAMES));
        this.send({ type: 'pcm-part', id, index, channel, offset, data }, [data.buffer]);
      }
      if (offset + PCM_PART_FRAMES < frames) await yieldTask();
    }
    if (!this.closed) this.send({ type: 'pcm-end', id, index });
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
  const w = ensureWorker();
  if (!w) return openTimelineMixStream(entries, provider, options);
  const id = nextId++;
  const stream = new WorkerMixStream(id, w, provider);
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
  worker?.terminate();
  worker = null;
  workerFailed = false;
  streams.clear();
  factory = next === undefined ? (typeof Worker === 'undefined' ? null : defaultFactory) : next;
}
