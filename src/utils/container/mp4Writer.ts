/**
 * The app's one MP4 muxer: WebCodecs chunks in, a finished `.mp4` buffer out.
 * Backed by Mediabunny; nothing outside `src/utils/container/` imports it, and
 * it is loaded on first use (`mediabunnyMp4.ts`) so it stays out of the entry
 * chunk.
 *
 * Mediabunny's packet API is async while `VideoEncoder` / `AudioEncoder`
 * output callbacks are synchronous, so `add*` never blocks: it copies the
 * chunk, rebases its timestamp and chains the real add on one queue in call
 * order. A failed add is held, not thrown (an exception in a codec callback
 * would vanish), and later adds are dropped; `throwIfFailed()` lets an encode
 * loop stop early and `finalize()` rethrows it after draining the queue.
 *
 * Policy every caller relied on with mp4-muxer, fixed here:
 * - Fast start in memory (`moov` before `mdat`). The target is an in-memory
 *   buffer, so an add never waits on the writer and packet order across
 *   tracks is free — export adds all video, then all audio.
 * - Each track is offset so its first packet sits at 0 (mp4-muxer's
 *   `firstTimestampBehavior: 'offset'`). Mediabunny would otherwise keep the
 *   gap and write an edit list.
 * - An AAC track whose chunks carry no decoder config gets an AAC-LC
 *   AudioSpecificConfig built from the declared rate / channels.
 * - A declared track that receives no packets is left out of the file.
 */

import type { BufferTarget, EncodedPacket, Mp4OutputFormat, Output } from 'mediabunny';

export type Mp4VideoCodec = 'avc' | 'hevc' | 'av1';
export type Mp4AudioCodec = 'aac';

export interface Mp4VideoTrackOptions {
  codec: Mp4VideoCodec;
  width: number;
  height: number;
  /** Track timescale in Hz; timestamps snap to its grid (mp4-muxer's `video.frameRate`). */
  frameRate?: number;
}

export interface Mp4AudioTrackOptions {
  codec: Mp4AudioCodec;
  sampleRate: number;
  numberOfChannels: number;
}

export interface Mp4WriterOptions {
  video?: Mp4VideoTrackOptions;
  audio?: Mp4AudioTrackOptions;
}

/** One encoded sample. Times are microseconds, like WebCodecs chunks; `data` is kept, not copied. */
export interface Mp4Packet {
  data: Uint8Array;
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number | null;
}

type Mediabunny = typeof import('./mediabunnyMp4');

interface TrackState<M> {
  add: ((packet: EncodedPacket, meta: M | undefined) => Promise<void>) | null;
  firstTimestampUs: number | null;
}

let mediabunny: Promise<Mediabunny> | null = null;

function loadMediabunny(): Promise<Mediabunny> {
  mediabunny ??= import('./mediabunnyMp4').catch((err: unknown) => {
    mediabunny = null; // a failed chunk load may succeed next time
    throw err;
  });
  return mediabunny;
}

const AAC_LC_OBJECT_TYPE = 2;
const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** ISO 14496-3 AudioSpecificConfig for AAC-LC (an explicit 24-bit rate when it is not in the table). */
export function aacLcAudioSpecificConfig(sampleRate: number, numberOfChannels: number): Uint8Array {
  const fields: Array<[value: number, bits: number]> = [[AAC_LC_OBJECT_TYPE, 5]];
  const index = AAC_SAMPLE_RATES.indexOf(sampleRate);
  if (index >= 0) {
    fields.push([index, 4]);
  } else {
    fields.push([15, 4], [sampleRate, 24]);
  }
  fields.push([numberOfChannels, 4]);

  const totalBits = fields.reduce((sum, [, bits]) => sum + bits, 0);
  const bytes = new Uint8Array(Math.ceil(totalBits / 8));
  let pos = 0;
  for (const [value, bits] of fields) {
    for (let bit = bits - 1; bit >= 0; bit--, pos++) {
      if ((value >>> bit) & 1) bytes[pos >> 3] |= 0x80 >> (pos & 7);
    }
  }
  return bytes;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Own copy, since the add runs after the codec callback returns. */
function copyDescription(description: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!description) return undefined;
  const view = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  return view.slice();
}

function packetFromChunk(chunk: EncodedVideoChunk | EncodedAudioChunk): Mp4Packet {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return { data, type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration };
}

export class Mp4Writer {
  private mediabunny: Mediabunny | null = null;
  private output: Output<Mp4OutputFormat, BufferTarget> | null = null;
  private target: BufferTarget | null = null;
  private readonly videoOptions: Mp4VideoTrackOptions | null;
  private readonly audioOptions: Mp4AudioTrackOptions | null;
  private readonly video: TrackState<EncodedVideoChunkMetadata> | null;
  private readonly audio: TrackState<EncodedAudioChunkMetadata> | null;
  private queue: Promise<void>;
  private failure: Error | null = null;
  private finalized = false;

  constructor(options: Mp4WriterOptions) {
    if (!options.video && !options.audio) {
      throw new Error('Mp4Writer needs a video or an audio track');
    }
    this.videoOptions = options.video ?? null;
    this.audioOptions = options.audio ?? null;
    this.video = options.video ? { add: null, firstTimestampUs: null } : null;
    this.audio = options.audio ? { add: null, firstTimestampUs: null } : null;
    this.queue = loadMediabunny()
      .then((mb) => this.start(mb))
      .catch(this.fail);
  }

  /** Throws the first load / start / add failure so a long encode loop can stop early. */
  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    this.addVideoPacket(packetFromChunk(chunk), meta);
  }

  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    this.addAudioPacket(packetFromChunk(chunk), meta);
  }

  addVideoPacket(packet: Mp4Packet, meta?: EncodedVideoChunkMetadata): void {
    const declared = this.videoOptions;
    if (!this.video || !declared) throw new Error('Mp4Writer has no video track');
    this.enqueue(this.video, packet, () => {
      const config = meta?.decoderConfig;
      if (!config) return meta;
      // The declared size is what the file advertises, as with mp4-muxer; it
      // also covers an encoder that leaves the coded size out.
      return {
        ...meta,
        decoderConfig: {
          ...config,
          codedWidth: declared.width,
          codedHeight: declared.height,
          description: copyDescription(config.description),
        },
      };
    });
  }

  addAudioPacket(packet: Mp4Packet, meta?: EncodedAudioChunkMetadata): void {
    const declared = this.audioOptions;
    if (!this.audio || !declared) throw new Error('Mp4Writer has no audio track');
    this.enqueue(this.audio, packet, (first) => {
      const config = meta?.decoderConfig;
      if (config) {
        return { ...meta, decoderConfig: { ...config, description: copyDescription(config.description) } };
      }
      if (!first) return meta;
      return {
        decoderConfig: {
          codec: 'mp4a.40.2',
          sampleRate: declared.sampleRate,
          numberOfChannels: declared.numberOfChannels,
          description: aacLcAudioSpecificConfig(declared.sampleRate, declared.numberOfChannels),
        },
      };
    });
  }

  /**
   * Drain pending adds, write the file and return its bytes. Rethrows the
   * first failure (and cancels the output) rather than writing a file that
   * silently lost packets.
   */
  async finalize(): Promise<ArrayBuffer> {
    if (this.finalized) throw new Error('Mp4Writer was already finalized');
    this.finalized = true;
    await this.queue;
    if (this.failure || !this.output || !this.target) {
      await this.output?.cancel().catch(() => undefined);
      throw this.failure ?? new Error('Mp4Writer never started');
    }
    await this.output.finalize();
    const { buffer } = this.target;
    if (!buffer) throw new Error('Mp4Writer finished without output');
    return buffer;
  }

  private readonly fail = (err: unknown): void => {
    this.failure ??= toError(err);
  };

  private async start(mb: Mediabunny): Promise<void> {
    const target = new mb.BufferTarget();
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    if (this.videoOptions && this.video) {
      const { codec, frameRate } = this.videoOptions;
      const source = new mb.EncodedVideoPacketSource(codec);
      output.addVideoTrack(source, frameRate !== undefined ? { frameRate } : {});
      this.video.add = (packet, meta) => source.add(packet, meta);
    }
    if (this.audioOptions && this.audio) {
      const source = new mb.EncodedAudioPacketSource(this.audioOptions.codec);
      output.addAudioTrack(source);
      this.audio.add = (packet, meta) => source.add(packet, meta);
    }
    this.mediabunny = mb;
    this.output = output;
    this.target = target;
    await output.start();
  }

  private enqueue<M>(
    track: TrackState<M>,
    packet: Mp4Packet,
    resolveMeta: (first: boolean) => M | undefined,
  ): void {
    if (this.finalized) throw new Error('Mp4Writer: packet added after finalize()');
    if (this.failure) return;

    let meta: M | undefined;
    const first = track.firstTimestampUs === null;
    track.firstTimestampUs ??= packet.timestamp;
    const timestamp = (packet.timestamp - track.firstTimestampUs) / 1e6;
    const duration = Math.max(0, packet.duration ?? 0) / 1e6;
    try {
      meta = resolveMeta(first);
    } catch (err) {
      this.fail(err);
      return;
    }

    this.queue = this.queue
      .then(() => {
        const mb = this.mediabunny;
        if (this.failure || !mb || !track.add) return;
        return track.add(new mb.EncodedPacket(packet.data, packet.type, timestamp, duration), meta);
      })
      .catch(this.fail);
  }
}
