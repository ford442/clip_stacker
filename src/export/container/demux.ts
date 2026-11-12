/**
 * The app's one demuxer: a clip `Blob` in, its primary video track's decoder
 * config and encoded packets out. Backed by Mediabunny (MP4, MOV, WebM, MKV)
 * over a `BlobSource`, so opening a reader parses the container index (`moov`,
 * WebM cues / cluster headers) and reads the packets it decodes — never the
 * whole file. Every WebCodecs reader of clip media (export cursors, the
 * preview worker, proxies, stabilization) comes through `openVideoDemux`, via
 * `ClipFrameDecoder` (`webcodecsDecoder.ts`).
 *
 * One index per Blob: the parsed input is cached in a WeakMap, so the cursor
 * a backward scrub reopens reuses the parsed `moov` and the source's read
 * cache. A rejected open is evicted, so a transient read failure is not
 * remembered for the life of the clip.
 *
 * Mediabunny is loaded on first use (`mediabunnyDemux.ts`), like the muxer,
 * so it stays out of the entry chunk.
 */

import type {
  EncodedPacket,
  EncodedPacketSink,
  InputVideoTrack,
  PacketRetrievalOptions,
  VideoSinkDecoderOptions,
} from 'mediabunny';

type Mediabunny = typeof import('./mediabunnyDemux');

/**
 * Read cache per open file (Mediabunny's default is 8 MiB). An index lives as
 * long as its Blob, so this stays small: sequential decode streams through
 * it, and a reopen near the last position still hits it.
 */
const SOURCE_CACHE_BYTES = 4 * 2 ** 20;

/** Packets scanned for the earliest presentation time (B-frames reorder the first GOP). */
const BASE_TIMESTAMP_SCAN_PACKETS = 16;

/** Key lookup slack, so a key frame a float ulp after the start time is still the start. */
const KEY_LOOKUP_EPSILON_SEC = 1e-6;

/** Container key flags are checked against the bitstream (an `stss` entry may not be an IDR). */
const VERIFIED_PACKETS: PacketRetrievalOptions = { verifyKeyPackets: true };

const DONE: IteratorReturnResult<undefined> = { value: undefined, done: true };

let mediabunny: Promise<Mediabunny> | null = null;

function loadMediabunny(): Promise<Mediabunny> {
  mediabunny ??= import('./mediabunnyDemux').catch((err: unknown) => {
    mediabunny = null; // a failed chunk load may succeed next time
    throw err;
  });
  return mediabunny;
}

/** One encoded video sample, in decode order. Times are microseconds from the track's first frame. */
export interface DemuxPacket {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number;
  readonly data: Uint8Array;
}

/**
 * A pull stream its reader must `close()`: Mediabunny reads (and decodes)
 * ahead of the reader until it is stopped.
 */
export interface DemuxStream<T> {
  next(): Promise<IteratorResult<T, undefined>>;
  /** Stop reading ahead. Idempotent; a `next()` after it resolves done. */
  close(): void;
}

export interface SampleDecodeOptions {
  hardwareAcceleration: HardwareAcceleration;
  /** Preview cursors only (see `ClipFrameDecoderOptions.optimizeForLatency`). */
  optimizeForLatency?: boolean;
}

export interface VideoDemux {
  /**
   * codec, coded size, `description`, display aspect and, when the file is
   * tagged, a complete `colorSpace` — so decoded frames carry the tags. No
   * acceleration hint: `ClipFrameDecoder` picks the rung per machine.
   */
  readonly config: VideoDecoderConfig;
  /** The container's / bitstream's colour tags as found (possibly partial), or null when untagged. */
  readonly colorSpace: VideoColorSpaceInit | null;
  /** The track may carry alpha (WebM `AlphaMode`, ProRes 4444): decode it with `decodeFrames`. */
  readonly hasAlpha: boolean;
  /**
   * Packets in decode order from the last key packet at or before `startSec`
   * (seconds from the first frame) to the end of the track.
   */
  packets(startSec: number): DemuxStream<DemuxPacket>;
  /**
   * Frames in presentation order — the one showing at `startSec` first — from
   * Mediabunny's own decoder, which decodes the alpha side data with a second
   * `VideoDecoder` and merges it in (I420A). Timestamps are rebased like
   * `packets`; the reader owns and closes every frame.
   */
  decodeFrames(startSec: number, endSec: number, options: SampleDecodeOptions): DemuxStream<VideoFrame>;
}

function toDemuxPacket(packet: EncodedPacket, baseSec: number): DemuxPacket {
  return {
    type: packet.type,
    timestamp: Math.round((packet.timestamp - baseSec) * 1_000_000),
    duration: Math.round(packet.duration * 1_000_000),
    data: packet.data,
  };
}

class MediabunnyVideoDemux implements VideoDemux {
  constructor(
    private readonly mb: Mediabunny,
    private readonly track: InputVideoTrack,
    private readonly sink: EncodedPacketSink,
    /** Container seconds the decoder path calls 0. */
    private readonly baseSec: number,
    readonly config: VideoDecoderConfig,
    readonly colorSpace: VideoColorSpaceInit | null,
    readonly hasAlpha: boolean,
  ) {}

  packets(startSec: number): DemuxStream<DemuxPacket> {
    const { sink, baseSec } = this;
    let inner: AsyncGenerator<EncodedPacket, void, unknown> | null = null;
    let closed = false;
    return {
      async next() {
        if (closed) return DONE;
        if (!inner) {
          const start =
            (await sink.getKeyPacket(startSec + baseSec + KEY_LOOKUP_EPSILON_SEC, VERIFIED_PACKETS)) ??
            (await sink.getFirstKeyPacket(VERIFIED_PACKETS));
          if (closed || !start) return DONE;
          inner = sink.packets(start, undefined, VERIFIED_PACKETS);
        }
        const result = await inner.next();
        if (closed || result.done) return DONE;
        return { value: toDemuxPacket(result.value, baseSec), done: false };
      },
      close() {
        if (closed) return;
        closed = true;
        void inner?.return(undefined);
      },
    };
  }

  decodeFrames(startSec: number, endSec: number, options: SampleDecodeOptions): DemuxStream<VideoFrame> {
    const { baseSec } = this;
    const decoderOptions: VideoSinkDecoderOptions = { hardwareAcceleration: options.hardwareAcceleration };
    if (options.optimizeForLatency) decoderOptions.optimizeForLatency = true;
    // `samples()` starts decoding right away; `close()` stops it and closes its decoders.
    const samples = new this.mb.VideoSampleSink(this.track, decoderOptions).samples(
      startSec + baseSec,
      endSec + baseSec,
    );
    let closed = false;
    return {
      async next() {
        if (closed) return DONE;
        const result = await samples.next();
        if (result.done) return DONE;
        const sample = result.value;
        try {
          if (closed) return DONE;
          sample.setTimestamp(sample.timestamp - baseSec);
          // A new handle on the same frame; closing the sample does not close it.
          return { value: sample.toVideoFrame(), done: false };
        } finally {
          sample.close();
        }
      },
      close() {
        if (closed) return;
        closed = true;
        void samples.return(undefined);
      },
    };
  }
}

/**
 * Colour tags worth carrying, or null when the file says nothing about
 * primaries, transfer or matrix (a lone range bit is the VUI default, not a tag).
 */
function taggedColorSpace(colorSpace: VideoColorSpaceInit | undefined): VideoColorSpaceInit | null {
  if (!colorSpace) return null;
  const { primaries, transfer, matrix, fullRange } = colorSpace;
  if (primaries == null && transfer == null && matrix == null) return null;
  const tags: VideoColorSpaceInit = {};
  if (primaries != null) tags.primaries = primaries;
  if (transfer != null) tags.transfer = transfer;
  if (matrix != null) tags.matrix = matrix;
  if (fullRange != null) tags.fullRange = fullRange;
  return tags;
}

/**
 * Chromium ignores a partially filled `colorSpace` and drops the tags it did
 * get, so the gaps take its own defaults (as Mediabunny's decoder does).
 */
function completeColorSpace(tags: VideoColorSpaceInit): VideoColorSpaceInit {
  return {
    primaries: tags.primaries ?? 'bt709',
    transfer: tags.transfer ?? 'bt709',
    matrix: tags.matrix ?? 'bt709',
    fullRange: tags.fullRange ?? false,
  };
}

function decoderConfigFrom(raw: VideoDecoderConfig, tags: VideoColorSpaceInit | null): VideoDecoderConfig {
  const config: VideoDecoderConfig = { codec: raw.codec };
  if (raw.codedWidth) config.codedWidth = raw.codedWidth;
  if (raw.codedHeight) config.codedHeight = raw.codedHeight;
  if (raw.displayAspectWidth && raw.displayAspectHeight) {
    config.displayAspectWidth = raw.displayAspectWidth;
    config.displayAspectHeight = raw.displayAspectHeight;
  }
  if (raw.description) config.description = raw.description;
  // Untagged files keep no colorSpace: the decoder reads the bitstream as before.
  if (tags) config.colorSpace = completeColorSpace(tags);
  return config;
}

/**
 * Container seconds of the earliest frame, which the decoder path calls 0
 * (the mp4box path rebased the earliest CTS the same way). Mediabunny applies
 * edit lists, so a stream-copied cut can start below 0: those frames stay
 * hidden, as in `<video>`.
 */
async function earliestPresentationTime(sink: EncodedPacketSink): Promise<number | null> {
  const metadataOnly: PacketRetrievalOptions = { metadataOnly: true };
  let packet = await sink.getFirstPacket(metadataOnly);
  if (!packet) return null;
  let earliest = packet.timestamp;
  for (let scanned = 1; scanned < BASE_TIMESTAMP_SCAN_PACKETS; scanned++) {
    packet = await sink.getNextPacket(packet, metadataOnly);
    if (!packet) break;
    earliest = Math.min(earliest, packet.timestamp);
  }
  return Math.max(0, earliest);
}

async function buildVideoDemux(source: Blob): Promise<VideoDemux> {
  const mb = await loadMediabunny();
  const input = new mb.Input({
    formats: [mb.MP4, mb.QTFF, mb.WEBM, mb.MATROSKA],
    source: new mb.BlobSource(source, { maxCacheSize: SOURCE_CACHE_BYTES }),
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found in clip');
    const raw = await track.getDecoderConfig();
    if (!raw) throw new Error('Unknown video codec in clip');
    const sink = new mb.EncodedPacketSink(track);
    const baseSec = await earliestPresentationTime(sink);
    if (baseSec === null) throw new Error('No video samples found in clip');
    const tags = taggedColorSpace(raw.colorSpace);
    const hasAlpha = await track.canBeTransparent();
    return new MediabunnyVideoDemux(mb, track, sink, baseSec, decoderConfigFrom(raw, tags), tags, hasAlpha);
  } catch (err) {
    input.dispose();
    throw err;
  }
}

const demuxes = new WeakMap<Blob, Promise<VideoDemux>>();

/** The (cached) demux index of `source`'s primary video track. Rejects for anything it cannot read. */
export function openVideoDemux(source: Blob): Promise<VideoDemux> {
  let pending = demuxes.get(source);
  if (!pending) {
    const built = buildVideoDemux(source);
    pending = built;
    demuxes.set(source, built);
    void built.catch(() => {
      if (demuxes.get(source) === built) demuxes.delete(source);
    });
  }
  return pending;
}

/**
 * The colour tags of `source`'s video track as the container (or, failing
 * that, the bitstream) states them — e.g. `{ primaries: 'bt2020', transfer:
 * 'pq', matrix: 'bt2020-ncl' }` for HDR10. Null when the file is untagged or
 * cannot be demuxed. Reads the cached index, so it costs one header parse per
 * Blob, shared with decoding.
 *
 * @public
 */
export async function readVideoColorSpace(source: Blob): Promise<VideoColorSpaceInit | null> {
  try {
    const { colorSpace } = await openVideoDemux(source);
    return colorSpace ? { ...colorSpace } : null;
  } catch {
    return null;
  }
}
