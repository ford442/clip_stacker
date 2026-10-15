import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFile, MP4BoxBuffer, type Movie } from 'mp4box';
import {
  buildSilentAacLoopInputArgs,
  createSilentAudioBuffer,
  encodeSilentAacUnitViaWebCodecs,
  ensureSilentAacUnit,
  getSilentAacUnitBytes,
  resetSilentAacUnitCacheForTesting,
  SILENT_AAC_CHANNELS,
  SILENT_AAC_SAMPLE_RATE,
  SILENT_AAC_UNIT_NAME,
  SILENT_AAC_UNIT_SEC,
} from './silentAudio';
import type { IFfmpegRuntime } from './ffmpegRuntime';

function mockFfmpeg(unitBytes = new Uint8Array([0, 1, 2, 3, 4])): IFfmpegRuntime {
  return {
    deleteFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(unitBytes),
    exec: vi.fn().mockResolvedValue(undefined),
  } as unknown as IFfmpegRuntime;
}

class FakeAudioBuffer {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  private channels: Float32Array[];
  constructor(opts: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = opts.length;
    this.numberOfChannels = opts.numberOfChannels;
    this.sampleRate = opts.sampleRate;
    this.channels = Array.from({ length: opts.numberOfChannels }, () => new Float32Array(opts.length));
  }
  getChannelData(ch: number): Float32Array {
    return this.channels[ch]!;
  }
}

/**
 * Stand-in WebCodecs AAC encoder: one 4-byte packet per AudioData, real
 * decoder config on the first output (as Chrome does). The muxer is real.
 */
function stubWebCodecsAudio(codec: string): void {
  class FakeAudioData {
    timestamp: number;
    numberOfFrames: number;
    sampleRate: number;
    constructor(init: { timestamp: number; numberOfFrames: number; sampleRate: number }) {
      this.timestamp = init.timestamp;
      this.numberOfFrames = init.numberOfFrames;
      this.sampleRate = init.sampleRate;
    }
    close(): void {}
  }
  class FakeAudioEncoder {
    static isConfigSupported = async () => ({ supported: true });
    state = 'unconfigured';
    private outputs = 0;
    private readonly output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void;
    constructor(init: { output: FakeAudioEncoder['output'] }) {
      this.output = init.output;
    }
    configure(): void {
      this.state = 'configured';
    }
    encode(data: FakeAudioData): void {
      const chunk = {
        type: 'key',
        timestamp: data.timestamp,
        duration: Math.round((data.numberOfFrames / data.sampleRate) * 1_000_000),
        byteLength: 4,
        copyTo: (dest: Uint8Array) => dest.set([0x21, 0x10, 0x04, 0x60]),
      } as unknown as EncodedAudioChunk;
      const meta =
        this.outputs++ === 0
          ? {
              decoderConfig: {
                codec,
                sampleRate: SILENT_AAC_SAMPLE_RATE,
                numberOfChannels: SILENT_AAC_CHANNELS,
                description: new Uint8Array([0x12, 0x10]),
              },
            }
          : undefined;
      this.output(chunk, meta);
    }
    async flush(): Promise<void> {}
    close(): void {
      this.state = 'closed';
    }
  }
  vi.stubGlobal('AudioBuffer', FakeAudioBuffer);
  vi.stubGlobal('AudioData', FakeAudioData);
  vi.stubGlobal('AudioEncoder', FakeAudioEncoder);
}

describe('silentAudio', () => {
  afterEach(() => {
    resetSilentAacUnitCacheForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('buildSilentAacLoopInputArgs loops the unit file', () => {
    expect(buildSilentAacLoopInputArgs()).toEqual([
      '-stream_loop',
      '-1',
      '-i',
      SILENT_AAC_UNIT_NAME,
    ]);
    expect(buildSilentAacLoopInputArgs('custom.m4a')).toEqual([
      '-stream_loop',
      '-1',
      '-i',
      'custom.m4a',
    ]);
  });

  it('createSilentAudioBuffer is zeros at the export sample rate', () => {
    // happy-dom may lack AudioBuffer / OfflineAudioContext; stub a minimal buffer.
    vi.stubGlobal('AudioBuffer', FakeAudioBuffer);

    const buf = createSilentAudioBuffer(0.5, SILENT_AAC_SAMPLE_RATE, 2);
    expect(buf.sampleRate).toBe(SILENT_AAC_SAMPLE_RATE);
    expect(buf.numberOfChannels).toBe(2);
    expect(buf.length).toBe(Math.ceil(0.5 * SILENT_AAC_SAMPLE_RATE));
    const ch0 = buf.getChannelData(0);
    expect(ch0[0]).toBe(0);
    expect(ch0[ch0.length - 1]).toBe(0);
  });

  it('getSilentAacUnitBytes falls back to a one-shot FFmpeg encode when WebCodecs is missing', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const unit = new Uint8Array([9, 8, 7]);
    const ffmpeg = mockFfmpeg(unit);

    const bytes = await getSilentAacUnitBytes(ffmpeg);
    expect(bytes).toEqual(unit);
    expect(ffmpeg.exec).toHaveBeenCalledTimes(1);
    const args = (ffmpeg.exec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(args).toContain('lavfi');
    expect(args).toContain(`anullsrc=r=${SILENT_AAC_SAMPLE_RATE}:cl=stereo`);
    expect(args).toContain(String(SILENT_AAC_UNIT_SEC));
    expect(args).toContain(SILENT_AAC_UNIT_NAME);

    // Cached: second call does not re-encode.
    await getSilentAacUnitBytes(ffmpeg);
    expect(ffmpeg.exec).toHaveBeenCalledTimes(1);
  });

  it('encodeSilentAacUnitViaWebCodecs muxes the encoded unit into an AAC-only MP4', async () => {
    stubWebCodecsAudio('mp4a.40.2');

    const bytes = await encodeSilentAacUnitViaWebCodecs(SILENT_AAC_UNIT_SEC);
    expect(bytes).not.toBeNull();

    const file = createFile();
    const ready: { info?: Movie } = {};
    file.onReady = (info) => {
      ready.info = info;
    };
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes!.slice().buffer, 0));
    file.flush();
    const movie = ready.info!;
    expect(movie.videoTracks).toHaveLength(0);
    expect(movie.audioTracks).toHaveLength(1);
    const [audio] = movie.audioTracks;
    expect(audio!.codec).toBe('mp4a.40.2');
    expect(audio!.audio?.sample_rate).toBe(SILENT_AAC_SAMPLE_RATE);
    expect(audio!.audio?.channel_count).toBe(SILENT_AAC_CHANNELS);
    expect(audio!.nb_samples).toBe(Math.ceil((SILENT_AAC_UNIT_SEC * SILENT_AAC_SAMPLE_RATE) / 1024));
  });

  it('getSilentAacUnitBytes falls back to FFmpeg when the WebCodecs unit cannot be muxed', async () => {
    stubWebCodecsAudio('mp4a.99'); // not an AAC codec string the muxer accepts
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unit = new Uint8Array([4, 5, 6]);
    const ffmpeg = mockFfmpeg(unit);

    expect(await getSilentAacUnitBytes(ffmpeg)).toEqual(unit);
    expect(ffmpeg.exec).toHaveBeenCalledTimes(1);
  });

  it('ensureSilentAacUnit writes cached bytes to the VFS', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const unit = new Uint8Array([1, 2, 3]);
    const ffmpeg = mockFfmpeg(unit);

    const name = await ensureSilentAacUnit(ffmpeg);
    expect(name).toBe(SILENT_AAC_UNIT_NAME);
    expect(ffmpeg.writeFile).toHaveBeenCalledWith(SILENT_AAC_UNIT_NAME, unit);
  });
});
