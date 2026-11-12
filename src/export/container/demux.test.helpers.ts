/**
 * Fixtures for the demux facade tests: synthetic MP4 / WebM files built with
 * the app's own muxers (no binaries committed), a Blob that logs every byte
 * read from it, and WebCodecs stand-ins — happy-dom decodes no media.
 */

import { vi } from 'vitest';
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Output,
  WebMOutputFormat,
} from 'mediabunny';
import { Mp4Writer } from './mp4Writer';

// A real SPS / PPS pair (High, level 3.1). Nothing decodes it; the demuxer
// parses the avcC and walks the length-prefixed NAL units of each packet.
const SPS = [
  0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00,
  0x10, 0x00, 0x00, 0x03, 0x03, 0xc0, 0xf1, 0x83, 0x19, 0x60,
];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];

function avcDecoderConfigurationRecord(): Uint8Array {
  return new Uint8Array([
    1, SPS[1]!, SPS[2]!, SPS[3]!, 0xff, 0xe1,
    SPS.length >> 8, SPS.length & 0xff, ...SPS,
    1, PPS.length >> 8, PPS.length & 0xff, ...PPS,
  ]);
}

/** One length-prefixed NAL unit (IDR or non-IDR slice) padded to `size` bytes. */
function avcPacket(key: boolean, size: number, index: number): Uint8Array {
  const data = new Uint8Array(size);
  new DataView(data.buffer).setUint32(0, size - 4);
  data[4] = key ? 0x65 : 0x41;
  data[5] = 0x88;
  data[6] = index & 0xff;
  data[7] = (index >> 8) & 0xff;
  return data;
}

export interface TestMp4Options {
  width: number;
  height: number;
  seconds?: number;
  fps?: number;
  /** Frames per GOP (a key frame every `gop` frames). */
  gop?: number;
  packetBytes?: number;
  colorSpace?: VideoColorSpaceInit;
}

/** An H.264 MP4 (fast start, `ftyp` `moov` `mdat`) of `seconds × fps` frames. */
export async function buildTestMp4(options: TestMp4Options): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, seconds = 10, fps = 30, gop = 30, packetBytes = 1024 } = options;
  const writer = new Mp4Writer({ video: { codec: 'avc', width, height, frameRate: fps } });
  const decoderConfig: VideoDecoderConfig = {
    codec: 'avc1.64001f',
    codedWidth: width,
    codedHeight: height,
    description: avcDecoderConfigurationRecord(),
  };
  if (options.colorSpace) decoderConfig.colorSpace = options.colorSpace;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    const key = i % gop === 0;
    writer.addVideoPacket(
      {
        data: avcPacket(key, packetBytes, i),
        type: key ? 'key' : 'delta',
        timestamp: Math.round((i * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      },
      i === 0 ? { decoderConfig } : undefined,
    );
  }
  return new Uint8Array(await writer.finalize());
}

/** A VP8 frame header (key frames carry the start code + size) padded to `size`. */
function vp8Frame(key: boolean, width: number, height: number, size: number): Uint8Array {
  const data = new Uint8Array(size);
  // Frame tag: bit 0 = 0 for key frames, bit 4 = show_frame.
  data[0] = key ? 0x10 : 0x11;
  if (key) {
    data.set([0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8], 3);
  }
  return data;
}

export interface TestWebmOptions {
  width: number;
  height: number;
  frames?: number;
  fps?: number;
  gop?: number;
  /** Carry an alpha frame in every block's BlockAdditions (AlphaMode = 1). */
  alpha?: boolean;
}

/** A VP8 WebM built with Mediabunny's muxer; with `alpha`, the layout Chrome / ffmpeg write. */
export async function buildTestWebm(options: TestWebmOptions): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, frames = 30, fps = 30, gop = 10, alpha = false } = options;
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new EncodedVideoPacketSource('vp8');
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  for (let i = 0; i < frames; i++) {
    const key = i % gop === 0;
    const packet = new EncodedPacket(
      vp8Frame(key, width, height, 256),
      key ? 'key' : 'delta',
      i / fps,
      1 / fps,
      -1,
      undefined,
      alpha ? { alpha: vp8Frame(key, width, height, 64) } : undefined,
    );
    await source.add(
      packet,
      i === 0 ? { decoderConfig: { codec: 'vp8', codedWidth: width, codedHeight: height } } : undefined,
    );
  }
  await output.finalize();
  return new Uint8Array(target.buffer!);
}

interface ByteRead {
  offset: number;
  length: number;
}

/** Shared across a ReadLoggingBlob and its slices. */
class ReadLog {
  readonly reads: ByteRead[] = [];
  /** Whole-Blob reads (`arrayBuffer()` / `stream()` / … on the Blob itself). */
  readonly wholeReads: string[] = [];

  get bytesRead(): number {
    return this.reads.reduce((sum, read) => sum + read.length, 0);
  }

  get largestRead(): number {
    return this.reads.reduce((max, read) => Math.max(max, read.length), 0);
  }

  reset(): void {
    this.reads.length = 0;
  }
}

const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * A Blob of `bytes` followed by a virtual `free` box (64-bit size) that pads
 * it to `virtualSize`, logging every byte read through it. Slices and their
 * streams are lazy and pull-based, like a browser's: a stream over the rest of
 * the file (Mediabunny's Chromium reader is `blob.slice(pos).stream()`) only
 * reads what its reader pulls, and is logged as such. Reading the Blob object
 * itself throws (and is logged), so a test fails on any whole-file copy.
 */
export class ReadLoggingBlob extends Blob {
  readonly log: ReadLog;
  private readonly isRoot: boolean;

  constructor(
    private readonly content: Uint8Array,
    private readonly virtualSize: number = content.byteLength,
    private readonly offset = 0,
    private readonly length = virtualSize,
    log?: ReadLog,
  ) {
    super([]);
    this.isRoot = log === undefined;
    this.log = log ?? new ReadLog();
  }

  override get size(): number {
    return this.length;
  }

  override get type(): string {
    return '';
  }

  /** File bytes at [start, end) of the virtual file: real bytes, then the `free` box. */
  private materialize(start: number, end: number): Uint8Array {
    const out = new Uint8Array(end - start);
    const real = this.content.byteLength;
    if (start < real) out.set(this.content.subarray(start, Math.min(end, real)));
    if (this.virtualSize > real) {
      const header = new Uint8Array(16);
      const view = new DataView(header.buffer);
      view.setUint32(0, 1); // size 1: a 64-bit largesize follows
      header.set([0x66, 0x72, 0x65, 0x65], 4); // 'free'
      view.setBigUint64(8, BigInt(this.virtualSize - real));
      for (let i = Math.max(start, real); i < Math.min(end, real + 16); i++) out[i - start] = header[i - real]!;
    }
    return out;
  }

  override slice(start = 0, end = this.length, _contentType?: string): ReadLoggingBlob {
    const clamp = (value: number) =>
      Math.min(this.length, Math.max(0, value < 0 ? this.length + value : value));
    const from = clamp(start);
    const to = Math.max(from, clamp(end));
    return new ReadLoggingBlob(this.content, this.virtualSize, this.offset + from, to - from, this.log);
  }

  private guardWhole(method: string): void {
    if (!this.isRoot) return;
    this.log.wholeReads.push(method);
    throw new Error(`whole-file ${method}() on a ${this.virtualSize}-byte Blob`);
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.guardWhole('arrayBuffer');
    this.log.reads.push({ offset: this.offset, length: this.length });
    return this.materialize(this.offset, this.offset + this.length).buffer as ArrayBuffer;
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.arrayBuffer());
  }

  override async text(): Promise<string> {
    this.guardWhole('text');
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    this.guardWhole('stream');
    let position = this.offset;
    const end = this.offset + this.length;
    return new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull: (controller) => {
          if (position >= end) {
            controller.close();
            return;
          }
          const next = Math.min(end, position + STREAM_CHUNK_BYTES);
          this.log.reads.push({ offset: position, length: next - position });
          controller.enqueue(this.materialize(position, next) as Uint8Array<ArrayBuffer>);
          position = next;
        },
      },
      { highWaterMark: 0 },
    );
  }
}

/** Stand-in `VideoFrame`: enough surface for the cursor, the pool and Mediabunny's `VideoSample`. */
export class FakeVideoFrame {
  static open = 0;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly format = 'I420';
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect = null;
  readonly colorSpace: VideoColorSpaceInit;
  /** Set by the fake alpha merge. */
  alphaMerged = false;
  closed = false;

  constructor(
    source: number | FakeVideoFrame,
    init: { timestamp?: number; duration?: number; width?: number; height?: number; colorSpace?: VideoColorSpaceInit } = {},
  ) {
    const base = typeof source === 'number' ? null : source;
    this.timestamp = init.timestamp ?? (typeof source === 'number' ? source : source.timestamp);
    this.duration = init.duration ?? base?.duration ?? null;
    this.codedWidth = init.width ?? base?.codedWidth ?? 640;
    this.codedHeight = init.height ?? base?.codedHeight ?? 360;
    this.displayWidth = this.codedWidth;
    this.displayHeight = this.codedHeight;
    this.colorSpace = init.colorSpace ?? base?.colorSpace ?? {};
    this.alphaMerged = base?.alphaMerged ?? false;
    FakeVideoFrame.open++;
  }

  clone(): FakeVideoFrame {
    return new FakeVideoFrame(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    FakeVideoFrame.open--;
  }
}

class FakeEncodedVideoChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  private readonly data: Uint8Array;

  constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    const data = init.data as ArrayBufferView | ArrayBuffer;
    this.data = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
      : new Uint8Array(data).slice();
    this.byteLength = this.data.byteLength;
  }

  copyTo(destination: Uint8Array): void {
    destination.set(this.data);
  }
}

export interface FakeWebCodecs {
  /** Every `configure()` call, in order. */
  configs: VideoDecoderConfig[];
  /** Chunk timestamps (µs) fed to any decoder, in order. */
  decoded: number[];
  isConfigSupported: ReturnType<typeof vi.fn>;
  /** Alpha merges the fake merge worker performed. */
  merges: number;
}

/**
 * Stub `VideoDecoder` / `EncodedVideoChunk` / `VideoFrame` (and a `Worker`
 * that plays Mediabunny's color/alpha merge worker). The decoder outputs one
 * frame per chunk, asynchronously, in decode order — the fixtures have no
 * B-frames, so that is presentation order. `supported` decides
 * `isConfigSupported`. Undo with `vi.unstubAllGlobals()`.
 */
export function installFakeWebCodecs(
  supported: (config: VideoDecoderConfig) => boolean = () => true,
): FakeWebCodecs {
  const state: FakeWebCodecs = {
    configs: [],
    decoded: [],
    isConfigSupported: vi.fn(async (config: VideoDecoderConfig) => ({ supported: supported(config), config })),
    merges: 0,
  };

  class FakeVideoDecoder {
    static isConfigSupported = state.isConfigSupported;
    state: CodecState = 'unconfigured';
    decodeQueueSize = 0;
    private pending = 0;
    private config: VideoDecoderConfig | null = null;

    constructor(private readonly init: VideoDecoderInit) {}

    configure(config: VideoDecoderConfig): void {
      state.configs.push(config);
      this.config = config;
      this.state = 'configured';
    }

    decode(chunk: FakeEncodedVideoChunk): void {
      if (this.state !== 'configured') throw new Error(`decode() while ${this.state}`);
      state.decoded.push(chunk.timestamp);
      this.pending++;
      queueMicrotask(() => {
        this.pending--;
        if (this.state !== 'configured') return;
        const frame = new FakeVideoFrame(chunk.timestamp, {
          ...(chunk.duration !== null ? { duration: chunk.duration } : {}),
          ...(this.config?.codedWidth ? { width: this.config.codedWidth } : {}),
          ...(this.config?.codedHeight ? { height: this.config.codedHeight } : {}),
          ...(this.config?.colorSpace ? { colorSpace: this.config.colorSpace } : {}),
        });
        this.init.output(frame as unknown as VideoFrame);
      });
    }

    async flush(): Promise<void> {
      while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    reset(): void {
      this.state = 'unconfigured';
    }

    close(): void {
      this.state = 'closed';
    }

    addEventListener(): void {}
    removeEventListener(): void {}
  }

  /** Mediabunny's merge worker protocol: `{ id, color, alpha }` in, `{ id, frame }` out. */
  class FakeMergeWorker {
    private listeners: Array<(event: { data: unknown }) => void> = [];

    addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
      if (type === 'message') this.listeners.push(listener);
    }

    postMessage(message: { id: number; color: FakeVideoFrame; alpha: FakeVideoFrame }): void {
      const { id, color, alpha } = message;
      setTimeout(() => {
        alpha.close();
        color.alphaMerged = true;
        state.merges++;
        for (const listener of this.listeners) listener({ data: { id, frame: color } });
      }, 0);
    }

    terminate(): void {}
  }

  vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
  vi.stubGlobal('VideoFrame', FakeVideoFrame);
  vi.stubGlobal('Worker', FakeMergeWorker);
  return state;
}

/** Drain a frame iterator (closing every frame), returning the timestamps in seconds. */
export async function collectFrameTimes(frames: AsyncIterable<VideoFrame>): Promise<number[]> {
  const times: number[] = [];
  for await (const frame of frames) {
    times.push(frame.timestamp / 1_000_000);
    frame.close();
  }
  return times;
}
