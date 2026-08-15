import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSilentAacLoopInputArgs,
  createSilentAudioBuffer,
  ensureSilentAacUnit,
  getSilentAacUnitBytes,
  resetSilentAacUnitCacheForTesting,
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

describe('silentAudio', () => {
  afterEach(() => {
    resetSilentAacUnitCacheForTesting();
    vi.unstubAllGlobals();
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
    class FakeAudioBuffer {
      length: number;
      numberOfChannels: number;
      sampleRate: number;
      private channels: Float32Array[];
      constructor(opts: {
        length: number;
        numberOfChannels: number;
        sampleRate: number;
      }) {
        this.length = opts.length;
        this.numberOfChannels = opts.numberOfChannels;
        this.sampleRate = opts.sampleRate;
        this.channels = Array.from(
          { length: opts.numberOfChannels },
          () => new Float32Array(opts.length),
        );
      }
      getChannelData(ch: number): Float32Array {
        return this.channels[ch]!;
      }
    }
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

  it('ensureSilentAacUnit writes cached bytes to the VFS', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const unit = new Uint8Array([1, 2, 3]);
    const ffmpeg = mockFfmpeg(unit);

    const name = await ensureSilentAacUnit(ffmpeg);
    expect(name).toBe(SILENT_AAC_UNIT_NAME);
    expect(ffmpeg.writeFile).toHaveBeenCalledWith(SILENT_AAC_UNIT_NAME, unit);
  });
});
