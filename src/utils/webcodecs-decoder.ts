/**
 * WebCodecs VideoDecoder frame source for GPU export.
 *
 * Demuxes an MP4/MOV clip with mp4box, feeds encoded samples to a hardware
 * VideoDecoder, and delivers decoded VideoFrames sequentially through a small
 * ring buffer so decode overlaps GPU composite + encode. This replaces the
 * HTMLVideoElement seek/requestVideoFrameCallback loop in the export hot path:
 * frame delivery is exact (no seek imprecision) and runs as fast as the
 * decoder allows instead of at (playbackRate × realtime).
 *
 * Callers should treat failures as recoverable and fall back to the
 * element-based capture path (see webcodecs.ts).
 */

import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import type { ISOFile, Sample, Track } from 'mp4box';

/** Max decoded frames buffered ahead of the consumer (ring buffer depth). */
export const FRAME_RING_BUFFER_CAPACITY = 8;

/** Max encoded chunks queued inside the decoder before we yield to output. */
const MAX_DECODE_QUEUE_DEPTH = 16;

/** Timing info needed to pick the decode window (subset of mp4box Sample). */
export interface SampleTiming {
  /** Composition timestamp in track timescale units. */
  cts: number;
  /** Track timescale (units per second). */
  timescale: number;
  /** True for sync (key) samples. */
  is_sync: boolean;
}

export interface DecodeWindow {
  /** Index of the sync sample to start decoding from (decode order). */
  startIndex: number;
  /** Last sample index (inclusive) that must be decoded to cover the trim. */
  endIndex: number;
}

/**
 * Choose which samples must be fed to the decoder to produce frames in
 * [trimStart, trimEnd): start at the last sync sample at or before trimStart
 * (frames before the trim are decoded and dropped), end at the last sample
 * that presents before trimEnd.
 */
export function selectDecodeWindow(
  samples: SampleTiming[],
  trimStartSec: number,
  trimEndSec: number,
  baseCts = 0,
): DecodeWindow | null {
  if (samples.length === 0) return null;

  let startIndex = 0;
  let endIndex = -1;
  for (let i = 0; i < samples.length; i++) {
    const ctsSec = (samples[i].cts - baseCts) / samples[i].timescale;
    if (samples[i].is_sync && ctsSec <= trimStartSec) startIndex = i;
    if (ctsSec < trimEndSec) endIndex = i;
  }
  if (endIndex < startIndex) return null;
  return { startIndex, endIndex };
}

/** Earliest composition timestamp of the track (normalizes clips that don't start at 0). */
export function computeBaseCts(samples: SampleTiming[]): number {
  let base = Infinity;
  for (const sample of samples) base = Math.min(base, sample.cts);
  return Number.isFinite(base) ? base : 0;
}

/** Whether a decoded frame at `timestampSec` falls inside the trim window. */
export function isFrameInTrimWindow(
  timestampSec: number,
  trimStartSec: number,
  trimEndSec: number,
  frameEpsilonSec = 1 / 240,
): boolean {
  return timestampSec >= trimStartSec - frameEpsilonSec && timestampSec < trimEndSec - frameEpsilonSec;
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

interface DemuxedClip {
  isoFile: ISOFile;
  buffer: ArrayBuffer;
  track: Track;
  samples: Sample[];
  config: VideoDecoderConfig;
}

/** Extract the codec-private description (avcC/hvcC/vpcC/av1C) for VideoDecoder. */
function extractDecoderDescription(isoFile: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = isoFile.getTrackById(trackId) as unknown as {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: unknown[] } } } };
  };
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
  for (const entry of entries) {
    const boxes = entry as Record<string, { write: (stream: DataStream) => void } | undefined>;
    const box = boxes.avcC ?? boxes.hvcC ?? boxes.vpcC ?? boxes.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      // Strip the 8-byte box header (size + fourcc); the payload is the config record.
      return new Uint8Array(stream.buffer as ArrayBuffer, 8);
    }
  }
  return undefined;
}

async function demuxClip(source: Blob): Promise<DemuxedClip> {
  const buffer = await source.arrayBuffer();
  const isoFile = createFile();

  const info = await new Promise<import('mp4box').Movie>((resolve, reject) => {
    isoFile.onReady = resolve;
    isoFile.onError = (_module, message) => reject(new Error(`MP4 demux failed: ${message}`));
    try {
      isoFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0), true);
      isoFile.flush();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const track = info.videoTracks[0];
  if (!track) throw new Error('No video track found in clip');

  const samples = isoFile.getTrackSamplesInfo(track.id);
  if (!samples || samples.length === 0) throw new Error('No video samples found in clip');

  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video?.width || track.track_width,
    codedHeight: track.video?.height || track.track_height,
    hardwareAcceleration: 'no-preference',
  };
  const description = extractDecoderDescription(isoFile, track.id);
  if (description) config.description = description;

  return { isoFile, buffer, track, samples, config };
}

export interface ClipFrameDecoderOptions {
  /** Trim window start within the source, seconds. */
  trimStart: number;
  /** Trim window end within the source, seconds. */
  trimEnd: number;
  /** Ring buffer depth override (default FRAME_RING_BUFFER_CAPACITY). */
  ringBufferCapacity?: number;
}

/**
 * Sequential VideoFrame source for one clip. Create with `ClipFrameDecoder.open`,
 * consume with `for await (const frame of decoder.frames())`, always `close()`.
 * The consumer owns each yielded frame and must call `frame.close()` on it.
 */
export class ClipFrameDecoder {
  private decoder: VideoDecoder;
  private queue: AsyncFrameQueue<VideoFrame>;
  private demuxed: DemuxedClip;
  private opts: ClipFrameDecoderOptions;
  private baseCts: number;
  private window: DecodeWindow;
  private disposed = false;

  private constructor(
    demuxed: DemuxedClip,
    decoder: VideoDecoder,
    queue: AsyncFrameQueue<VideoFrame>,
    opts: ClipFrameDecoderOptions,
    baseCts: number,
    window: DecodeWindow,
  ) {
    this.demuxed = demuxed;
    this.decoder = decoder;
    this.queue = queue;
    this.opts = opts;
    this.baseCts = baseCts;
    this.window = window;
  }

  /** Presentation timestamp (seconds, relative to clip start) of a decoded frame. */
  private frameTimeSec(frame: VideoFrame): number {
    return frame.timestamp / 1_000_000;
  }

  static async open(source: Blob, opts: ClipFrameDecoderOptions): Promise<ClipFrameDecoder> {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('VideoDecoder API not available');
    }

    const demuxed = await demuxClip(source);
    const support = await VideoDecoder.isConfigSupported(demuxed.config);
    if (!support.supported) {
      throw new Error(`VideoDecoder does not support ${demuxed.config.codec}`);
    }

    const baseCts = computeBaseCts(demuxed.samples);
    const window = selectDecodeWindow(demuxed.samples, opts.trimStart, opts.trimEnd, baseCts);
    if (!window) throw new Error('Trim window contains no video samples');

    const queue = new AsyncFrameQueue<VideoFrame>(
      opts.ringBufferCapacity ?? FRAME_RING_BUFFER_CAPACITY,
    );
    const decoder = new VideoDecoder({
      output: (frame) => queue.push(frame),
      error: (err) => queue.fail(err instanceof Error ? err : new Error(String(err))),
    });
    decoder.configure(demuxed.config);

    return new ClipFrameDecoder(demuxed, decoder, queue, opts, baseCts, window);
  }

  /**
   * Yield decoded frames inside the trim window, presentation order, with
   * timestamps rebased so the first possible frame of the source is 0 µs.
   */
  async *frames(): AsyncGenerator<VideoFrame> {
    const { samples, buffer } = this.demuxed;
    const { trimStart, trimEnd } = this.opts;

    const emitOrDrop = (frame: VideoFrame): VideoFrame | null => {
      if (isFrameInTrimWindow(this.frameTimeSec(frame), trimStart, trimEnd)) return frame;
      frame.close();
      return null;
    };

    for (let i = this.window.startIndex; i <= this.window.endIndex; i++) {
      if (this.disposed) return;
      const sample = samples[i];
      const chunk = new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: Math.round(((sample.cts - this.baseCts) / sample.timescale) * 1_000_000),
        duration: Math.round((sample.duration / sample.timescale) * 1_000_000),
        data: new Uint8Array(buffer, sample.offset, sample.size),
      });
      this.decoder.decode(chunk);

      // Drain whatever the decoder produced; block when the ring buffer is
      // full so decode never runs unboundedly ahead of composite + encode.
      while (this.queue.size > 0 || this.queue.atCapacity) {
        const frame = await this.queue.pull();
        if (frame === null) return;
        const emitted = emitOrDrop(frame);
        if (emitted) yield emitted;
        if (this.queue.size === 0) break;
      }

      if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE_DEPTH) {
        await waitForDequeue(this.decoder);
      }
    }

    if (this.disposed) return;
    const flushDone = this.decoder.flush().then(
      () => this.queue.close(),
      (err) => this.queue.fail(err instanceof Error ? err : new Error(String(err))),
    );

    for (;;) {
      const frame = await this.queue.pull();
      if (frame === null) break;
      const emitted = emitOrDrop(frame);
      if (emitted) yield emitted;
    }
    await flushDone;
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.drain((frame) => frame.close());
    this.queue.close();
    try {
      if (this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // already closed
    }
  }
}

function waitForDequeue(decoder: VideoDecoder): Promise<void> {
  return new Promise((resolve) => {
    const target = decoder as unknown as EventTarget;
    if (typeof target.addEventListener === 'function') {
      target.addEventListener('dequeue', () => resolve(), { once: true });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Cheap probe: can this clip be served by the VideoDecoder path?
 * Returns false (never throws) when demux or decode support is missing.
 */
export async function canDecodeClipWithWebCodecs(source: Blob): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
    return false;
  }
  try {
    const demuxed = await demuxClip(source);
    const support = await VideoDecoder.isConfigSupported(demuxed.config);
    return support.supported === true;
  } catch {
    return false;
  }
}
