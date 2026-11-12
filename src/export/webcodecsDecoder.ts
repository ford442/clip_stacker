/**
 * WebCodecs VideoDecoder frame source for GPU export, the preview worker,
 * proxies and stabilization.
 *
 * Reads a clip through the demux facade (`container/demux.ts`, Mediabunny:
 * MP4, MOV, WebM, MKV), feeds the packets of the trim window to a
 * `VideoDecoder` and delivers decoded VideoFrames sequentially through a small
 * ring buffer so decode overlaps GPU composite + encode. This replaces the
 * HTMLVideoElement seek/requestVideoFrameCallback loop: frame delivery is
 * exact (no seek imprecision) and runs as fast as the decoder allows instead
 * of at (playbackRate × realtime). Opening reads the container index (cached
 * per Blob) and the packets decoded — never the whole file — so a cursor the
 * preview reopens on every backward scrub stays cheap on a 2 GB camera file.
 *
 * A track with alpha (WebM VP8 / VP9 `AlphaMode`) decodes through
 * Mediabunny's sample decoder instead, which decodes the alpha side data with
 * a second decoder and hands out merged I420A frames.
 *
 * Callers should treat failures as recoverable and fall back to the
 * element-based capture path (see webcodecs.ts).
 */

import { waitForQueueBelow } from './codecQueue';
import { DECODER_ACCELERATION_LADDER } from './webcodecsCodec';
import {
  openVideoDemux,
  type DemuxPacket,
  type DemuxStream,
  type SampleDecodeOptions,
  type VideoDemux,
} from './container/demux';

/** Max decoded frames buffered ahead of the consumer (ring buffer depth). */
export const FRAME_RING_BUFFER_CAPACITY = 8;

/** Max encoded chunks queued inside the decoder before we yield to output. */
const MAX_DECODE_QUEUE_DEPTH = 16;

/** Half a 120 fps frame: absorbs timestamp rounding at the trim edges. */
const FRAME_EPSILON_SEC = 1 / 240;

/**
 * Alpha tracks: color and alpha are merged on the CPU (both frames are copied
 * into one I420A frame), which needs readable frames of a known pixel format.
 * Software VP8 / VP9 decode guarantees that; a hardware decoder may hand out
 * GPU-only frames the merge cannot read.
 */
const ALPHA_DECODER_ACCELERATION_LADDER: readonly HardwareAcceleration[] = Object.freeze([
  'prefer-software',
  'no-preference',
]);

/** Whether a decoded frame at `timestampSec` falls inside the trim window. */
export function isFrameInTrimWindow(
  timestampSec: number,
  trimStartSec: number,
  trimEndSec: number,
  frameEpsilonSec = FRAME_EPSILON_SEC,
): boolean {
  return timestampSec >= trimStartSec - frameEpsilonSec && timestampSec < trimEndSec - frameEpsilonSec;
}

/** A decoded frame at `timestampSec` is past the window end (see `isFrameInTrimWindow`). */
function isPastTrimEnd(timestampSec: number, trimEndSec: number): boolean {
  return timestampSec >= trimEndSec - FRAME_EPSILON_SEC;
}

/**
 * Decides, packet by packet in decode order, when the trim window has been
 * fed. Once a key packet presents at or after `trimEnd`, nothing after it is
 * needed except open-GOP leading pictures (which present before that key and
 * reference it), so feeding stops at the first packet presenting at or after
 * it. Mid-GOP ends usually stop earlier: the decode loop also stops once a
 * decoded frame reaches `trimEnd` (output is in presentation order).
 */
export class DecodeWindowEnd {
  private readonly trimEndUs: number;
  private boundaryUs: number | null = null;

  constructor(trimEndSec: number) {
    this.trimEndUs = trimEndSec * 1_000_000;
  }

  /** True when `packet` (µs presentation time) and everything after it can be skipped. */
  isPast(packet: Pick<DemuxPacket, 'type' | 'timestamp'>): boolean {
    if (this.boundaryUs !== null) return packet.timestamp >= this.boundaryUs;
    if (packet.type === 'key' && packet.timestamp >= this.trimEndUs) this.boundaryUs = packet.timestamp;
    return false;
  }
}

/**
 * Bounded async FIFO connecting the decoder output callback (producer) to the
 * export loop (consumer). `push` never blocks — VideoDecoder output callbacks
 * cannot await — so producers must check `atCapacity` before decoding more.
 */
export class AsyncFrameQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T | null) => void> = [];
  private closed = false;
  private error: Error | null = null;

  constructor(readonly capacity: number = FRAME_RING_BUFFER_CAPACITY) {}

  get size(): number {
    return this.items.length;
  }

  get atCapacity(): boolean {
    return this.items.length >= this.capacity;
  }

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  /** Resolve with the next item, or null once the queue is closed and drained. */
  pull(): Promise<T | null> {
    if (this.error) return Promise.reject(this.error);
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  fail(error: Error): void {
    this.error = error;
    this.close();
  }

  drain(onItem: (item: T) => void): void {
    while (this.items.length > 0) onItem(this.items.shift()!);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

let lastDecoderAcceleration: HardwareAcceleration | null = null;

/** The acceleration rung the last opened clip decoder configured with — Copy Debug. */
export function getLastDecoderAcceleration(): HardwareAcceleration | null {
  return lastDecoderAcceleration;
}

/**
 * `config` with the first acceleration hint of `ladder` (default
 * {@link DECODER_ACCELERATION_LADDER}) that `isConfigSupported` accepts, or
 * null when none does. Hardware decode keeps export GPU-bound end to end; the
 * software rungs keep a machine with no (or a picky) hardware decoder on the
 * decoder path rather than `<video>` seeks.
 */
export async function resolveDecoderConfig(
  config: VideoDecoderConfig,
  ladder: readonly HardwareAcceleration[] = DECODER_ACCELERATION_LADDER,
): Promise<VideoDecoderConfig | null> {
  for (const hardwareAcceleration of ladder) {
    const candidate: VideoDecoderConfig = { ...config, hardwareAcceleration };
    try {
      const support = await VideoDecoder.isConfigSupported(candidate);
      if (support.supported === true) return candidate;
    } catch {
      // Try the next rung.
    }
  }
  return null;
}

/**
 * Accepted rung per ladder + codec + coded size. Support does not depend on
 * the file beyond those, so one probe serves every clip (and every reopen) of
 * that shape; each still configures with its own `description` / colour tags.
 * A ladder that found no rung is not kept, so a transient refusal is retried.
 */
const acceptedRungs = new Map<string, Promise<HardwareAcceleration | null>>();

function resolveDecoderAcceleration(
  config: VideoDecoderConfig,
  ladder: readonly HardwareAcceleration[],
): Promise<HardwareAcceleration | null> {
  const key = `${ladder.join('>')}|${config.codec}|${config.codedWidth ?? 0}x${config.codedHeight ?? 0}`;
  let pending = acceptedRungs.get(key);
  if (!pending) {
    const probe = resolveDecoderConfig(config, ladder).then(
      (resolved) => resolved?.hardwareAcceleration ?? null,
    );
    pending = probe;
    acceptedRungs.set(key, probe);
    void probe.then((rung) => {
      if (rung === null && acceptedRungs.get(key) === probe) acceptedRungs.delete(key);
    });
  }
  return pending;
}

export interface ClipFrameDecoderOptions {
  /** Trim window start within the source, seconds. */
  trimStart: number;
  /** Trim window end within the source, seconds. */
  trimEnd: number;
  /**
   * Start delivering at this source time inside the window instead of at
   * `trimStart`: decode begins at the key frame before it, and the first frame
   * delivered is the one showing at `startAt` (never one before `trimStart`).
   * A cursor reading from here hands out exactly the frames one that decoded
   * all the way from `trimStart` would. Scrubs and backward jumps use it.
   */
  startAt?: number;
  /** Ring buffer depth override (default FRAME_RING_BUFFER_CAPACITY). */
  ringBufferCapacity?: number;
  /**
   * Ask for a decoder that outputs each frame as soon as it can rather than
   * buffering for throughput. Preview cursors only — they are reopened on
   * every backward scrub, so time to first frame is what the user sees.
   * Export, proxies and stabilization leave it off.
   */
  optimizeForLatency?: boolean;
  /**
   * Decode as this colour space instead of the file's tags
   * (`Clip.colorSpaceOverride`): `VideoDecoderConfig.colorSpace` wins over
   * in-band VUI, so every frame carries it. Not applied to alpha tracks,
   * which Mediabunny decodes with the file's own configuration.
   */
  colorSpace?: VideoColorSpaceInit;
}

interface FrameSource {
  frames(): AsyncGenerator<VideoFrame>;
  close(): void;
}

/** Opaque tracks: demuxed packets → our own `VideoDecoder` → ring buffer. */
class PacketFrameSource implements FrameSource {
  private readonly decoder: VideoDecoder;
  private readonly queue: AsyncFrameQueue<VideoFrame>;
  private packets: DemuxStream<DemuxPacket> | null = null;
  /** With `startAt`: the latest window frame before it — the one showing at `startAt` so far. */
  private held: VideoFrame | null = null;
  private disposed = false;

  constructor(
    private readonly demux: VideoDemux,
    config: VideoDecoderConfig,
    private readonly opts: ClipFrameDecoderOptions,
    private readonly startAt: number,
  ) {
    const queue = new AsyncFrameQueue<VideoFrame>(opts.ringBufferCapacity ?? FRAME_RING_BUFFER_CAPACITY);
    this.queue = queue;
    this.decoder = new VideoDecoder({
      output: (frame) => queue.push(frame),
      error: (err) => queue.fail(toError(err)),
    });
    this.decoder.configure(config);
  }

  /**
   * Yield decoded frames inside the trim window, presentation order, with
   * timestamps rebased so the first frame of the source is 0 µs.
   */
  async *frames(): AsyncGenerator<VideoFrame> {
    const { trimStart, trimEnd } = this.opts;
    const { startAt } = this;
    const seeking = startAt > trimStart;
    const packets = this.demux.packets(startAt);
    this.packets = packets;
    const windowEnd = new DecodeWindowEnd(trimEnd);
    // Output is in presentation order: once a frame reaches trimEnd, every
    // frame of the window has been delivered.
    let reachedEnd = false;
    const releaseHeld = (): VideoFrame[] => {
      const held = this.held;
      this.held = null;
      return held ? [held] : [];
    };
    /** The frames to deliver for one decoded frame, in order (0, 1 or 2). */
    const accept = (frame: VideoFrame): VideoFrame[] => {
      const timeSec = frame.timestamp / 1_000_000;
      if (isPastTrimEnd(timeSec, trimEnd)) reachedEnd = true;
      if (reachedEnd || !isFrameInTrimWindow(timeSec, trimStart, trimEnd)) {
        frame.close();
        return reachedEnd ? releaseHeld() : [];
      }
      if (seeking && timeSec < startAt) {
        this.held?.close();
        this.held = frame;
        return [];
      }
      const held = releaseHeld();
      // A frame exactly at startAt shows there itself; otherwise the held one does.
      if (held[0] && timeSec <= startAt) {
        held[0].close();
        return [frame];
      }
      return [...held, frame];
    };

    try {
      for (;;) {
        if (this.disposed) return;
        if (reachedEnd) {
          this.stopDecoding();
          return;
        }
        const next = await packets.next();
        if (this.disposed) return;
        if (next.done || windowEnd.isPast(next.value)) break;
        const packet = next.value;
        this.decoder.decode(
          new EncodedVideoChunk({
            type: packet.type,
            timestamp: packet.timestamp,
            duration: packet.duration,
            data: packet.data,
          }),
        );

        // Drain whatever the decoder produced; decode never runs unboundedly
        // ahead of composite + encode (the queue wait below bounds it).
        while (this.queue.size > 0) {
          const frame = await this.queue.pull();
          if (frame === null) return;
          for (const emitted of accept(frame)) yield emitted;
        }

        // Rejects if the decoder errors (it closes) or stalls, rather than hanging.
        // A close() of our own mid-iteration just ends the stream.
        try {
          await waitForQueueBelow(this.decoder, MAX_DECODE_QUEUE_DEPTH + 1);
        } catch (err) {
          if (this.disposed) return;
          throw err;
        }
      }
    } finally {
      packets.close();
    }

    if (this.disposed) return;
    const flushDone = this.decoder.flush().then(
      () => this.queue.close(),
      (err) => this.queue.fail(toError(err)),
    );

    for (;;) {
      const frame = await this.queue.pull();
      if (frame === null) break;
      for (const emitted of accept(frame)) yield emitted;
    }
    await flushDone;
    // Nothing presented after startAt: the last frame before it still shows there.
    for (const emitted of releaseHeld()) yield emitted;
  }

  /** The window is complete: drop the decoder's remaining (later) output now. */
  private stopDecoding(): void {
    try {
      if (this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // already closed
    }
    this.queue.drain((frame) => frame.close());
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.packets?.close();
    this.held?.close();
    this.held = null;
    this.queue.drain((frame) => frame.close());
    this.queue.close();
    try {
      if (this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // already closed
    }
  }
}

/** Alpha tracks: Mediabunny decodes color + alpha and merges them; we only window the frames. */
class SampleFrameSource implements FrameSource {
  private disposed = false;

  constructor(
    private readonly stream: DemuxStream<VideoFrame>,
    private readonly opts: ClipFrameDecoderOptions,
  ) {}

  async *frames(): AsyncGenerator<VideoFrame> {
    const { trimStart, trimEnd } = this.opts;
    try {
      for (;;) {
        if (this.disposed) return;
        const next = await this.stream.next();
        if (next.done) return;
        const frame = next.value;
        const timeSec = frame.timestamp / 1_000_000;
        if (this.disposed || isPastTrimEnd(timeSec, trimEnd)) {
          frame.close();
          return;
        }
        if (isFrameInTrimWindow(timeSec, trimStart, trimEnd)) yield frame;
        else frame.close();
      }
    } finally {
      this.stream.close();
    }
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stream.close();
  }
}

/**
 * Sequential VideoFrame source for one clip. Create with `ClipFrameDecoder.open`,
 * consume with `for await (const frame of decoder.frames())`, always `close()`.
 * The consumer owns each yielded frame and must call `frame.close()` on it.
 */
export class ClipFrameDecoder {
  private constructor(private readonly source: FrameSource) {}

  static async open(source: Blob, opts: ClipFrameDecoderOptions): Promise<ClipFrameDecoder> {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('VideoDecoder API not available');
    }
    if (!(opts.trimEnd > opts.trimStart)) {
      throw new Error('Trim window contains no video samples');
    }

    const { trimStart, trimEnd } = opts;
    const startAt =
      opts.startAt !== undefined && opts.startAt > trimStart && opts.startAt < trimEnd
        ? opts.startAt
        : trimStart;

    const demux = await openVideoDemux(source);
    const ladder = demux.hasAlpha ? ALPHA_DECODER_ACCELERATION_LADDER : DECODER_ACCELERATION_LADDER;
    const hardwareAcceleration = await resolveDecoderAcceleration(demux.config, ladder);
    if (!hardwareAcceleration) {
      throw new Error(`VideoDecoder does not support ${demux.config.codec}`);
    }
    lastDecoderAcceleration = hardwareAcceleration;

    if (demux.hasAlpha) {
      const options: SampleDecodeOptions = { hardwareAcceleration };
      if (opts.optimizeForLatency) options.optimizeForLatency = true;
      // Mediabunny starts at the frame showing at startAt itself.
      const stream = demux.decodeFrames(startAt, trimEnd, options);
      return new ClipFrameDecoder(new SampleFrameSource(stream, opts));
    }

    const config: VideoDecoderConfig = { ...demux.config, hardwareAcceleration };
    if (opts.optimizeForLatency) config.optimizeForLatency = true;
    if (opts.colorSpace) config.colorSpace = { ...opts.colorSpace };
    return new ClipFrameDecoder(new PacketFrameSource(demux, config, opts, startAt));
  }

  /**
   * Yield decoded frames inside the trim window, presentation order, with
   * timestamps rebased so the first frame of the source is 0 µs.
   */
  frames(): AsyncGenerator<VideoFrame> {
    return this.source.frames();
  }

  close(): void {
    this.source.close();
  }
}
