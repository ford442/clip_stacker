import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, ClipTransition } from '../types';
import {
  AAC_FRAME_SAMPLES,
  assessWebCodecsAudioMix,
  encodeAudioBufferToAac,
  extractPlanarFrame,
  isAudioEncoderAvailable,
  MAX_OFFLINE_AUDIO_SECONDS,
} from './webcodecs-audio';

function makeClip(id: string, duration: number): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('webcodecs-audio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('isAudioEncoderAvailable', () => {
    it('returns false when AudioEncoder is missing', async () => {
      vi.stubGlobal('AudioEncoder', undefined);
      await expect(isAudioEncoderAvailable()).resolves.toBe(false);
    });

    it('returns true when isConfigSupported reports AAC-LC support', async () => {
      vi.stubGlobal('AudioEncoder', {
        isConfigSupported: vi.fn().mockResolvedValue({ supported: true }),
      });
      await expect(isAudioEncoderAvailable()).resolves.toBe(true);
    });
  });

  describe('assessWebCodecsAudioMix', () => {
    beforeEach(() => {
      vi.stubGlobal('OfflineAudioContext', class OfflineAudioContext {});
    });

    it('accepts simple multi-clip timelines', () => {
      const clips = [makeClip('a', 5), makeClip('b', 3)];
      expect(assessWebCodecsAudioMix(clips, [], [])).toEqual({ supported: true });
    });

    it('rejects timelines longer than the offline mix cap', () => {
      const clips = [makeClip('a', MAX_OFFLINE_AUDIO_SECONDS + 1)];
      const result = assessWebCodecsAudioMix(clips, [], []);
      expect(result.supported).toBe(false);
      if (!result.supported) {
        expect(result.reason).toMatch(/offline mix limit/i);
      }
    });

    it('supports dissolve transitions via schedule overlap', () => {
      const clips = [makeClip('a', 5), makeClip('b', 3)];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
      ];
      expect(assessWebCodecsAudioMix(clips, [], transitions)).toEqual({
        supported: true,
      });
    });
  });

  describe('extractPlanarFrame', () => {
    it('extracts partial final frames at EOF', () => {
      const buffer = {
        length: 100,
        numberOfChannels: 2,
        sampleRate: 48_000,
        getChannelData: (ch: number) => {
          const data = new Float32Array(100);
          data.fill(ch === 0 ? 0.5 : -0.5);
          return data;
        },
      } as unknown as AudioBuffer;

      const { data, channels, frames } = extractPlanarFrame(
        buffer,
        100 - AAC_FRAME_SAMPLES / 2,
        AAC_FRAME_SAMPLES,
      );

      expect(channels).toBe(2);
      expect(frames).toBe(AAC_FRAME_SAMPLES / 2);
      expect(data.length).toBe(frames * channels);
    });
  });

  describe('encodeAudioBufferToAac', () => {
    it('encodes full and partial AAC frames', async () => {
      const encode = vi.fn();
      const flush = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();

      class FakeAudioData {
        constructor(public readonly init: Record<string, unknown>) {}
        close() {}
      }

      vi.stubGlobal('AudioData', FakeAudioData);
      vi.stubGlobal('AudioEncoder', class {
        static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
        constructor(private readonly init: { output: (chunk: { timestamp: number }) => void }) {}
        configure() {}
        encode() {
          encode();
          this.init.output({ timestamp: encode.mock.calls.length * 1_000 });
        }
        flush = flush;
        close = close;
      });

      const buffer = {
        length: AAC_FRAME_SAMPLES + 200,
        numberOfChannels: 2,
        sampleRate: 48_000,
        getChannelData: () => new Float32Array(AAC_FRAME_SAMPLES + 200),
      } as unknown as AudioBuffer;

      const result = await encodeAudioBufferToAac(buffer);
      expect(encode).toHaveBeenCalledTimes(2);
      expect(result.chunks).toHaveLength(2);
      expect(flush).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    });
  });
});
