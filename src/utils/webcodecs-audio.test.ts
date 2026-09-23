import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Clip, ClipTransition } from '../types';
import {
  AAC_FRAME_SAMPLES,
  assessWebCodecsAudioMix,
  encodeAudioBufferToAac,
  encodeScheduleAudioStreaming,
  extractPlanarFrame,
  isAudioEncoderAvailable,
  MAX_OFFLINE_AUDIO_SECONDS,
  prepareStreamingAudioMix,
  renderTimelineAudioMix,
  timelineHasAudioAutomation,
} from './webcodecs-audio';
import {
  __setMediaEngineKillSwitchForTests,
  _resetMediaEngineLoadStateForTests,
  getLastMediaEngineMixBackend,
  loadMediaEngineModule,
  scheduleNeedsOfflineAudioMix,
} from '../wasm/mediaEngine';
import { sampleKeyframes } from './keyframes';
import type { AudioScheduleEntry } from '../audio/schedule';
import { applyGainEnvelope } from '../audio/playbackManager';
import { buildAudioSchedule } from '../audio/schedule';

const WASM_BASE = pathToFileURL(
  path.resolve(process.cwd(), 'public/wasm') + path.sep,
).href;

/** Minimal AudioBuffer over planar arrays (enough for the mixers and encoder). */
function fakeAudioBuffer(channels: Float32Array[], sampleRate = 48_000): AudioBuffer {
  return {
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    sampleRate,
    duration: channels[0]!.length / sampleRate,
    getChannelData: (ch: number) => channels[ch]!,
  } as unknown as AudioBuffer;
}

/** OfflineAudioContext stub: records construction lengths and rendering calls. */
function stubOfflineAudioContext() {
  const lengths: number[] = [];
  let startRenderingCalls = 0;
  class FakeOfflineAudioContext {
    sampleRate: number;
    constructor(_channels: number, length: number, sampleRate: number) {
      lengths.push(length);
      this.sampleRate = sampleRate;
    }
    createBuffer(channels: number, length: number, sampleRate: number) {
      return fakeAudioBuffer(
        Array.from({ length: channels }, () => new Float32Array(length)),
        sampleRate,
      );
    }
    async startRendering() {
      startRenderingCalls += 1;
      throw new Error('OfflineAudioContext graph should not render on the WASM path');
    }
  }
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  return { lengths, startRenderingCalls: () => startRenderingCalls };
}

function scheduleEntry(overrides: Partial<AudioScheduleEntry>): AudioScheduleEntry {
  return {
    clipId: 'a',
    objectUrl: 'blob:a',
    timelineStart: 0,
    duration: 1,
    cycleDuration: 1,
    loopCount: 1,
    bufferOffset: 0,
    volume: 1,
    audioFadeIn: 0,
    audioFadeOut: 0,
    playbackRate: 1,
    ...overrides,
  };
}

function makeClip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
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
    ...overrides,
  };
}

describe('webcodecs-audio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetMediaEngineLoadStateForTests();
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

    it('accepts long timelines when the streaming media-engine mix is ready', () => {
      const clips = [makeClip('a', 2 * 60 * 60)];
      expect(assessWebCodecsAudioMix(clips, [], [], { streamingMix: true })).toEqual({
        supported: true,
      });
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

  describe('automation schedule parity', () => {
    it('includes volume and pan automation on schedule entries', () => {
      const clips = [
        makeClip('a', 4, {
          volume: 0.8,
          automation: {
            volume: [
              { t: 0, value: 1 },
              { t: 2, value: 0.2 },
            ],
            pan: [{ t: 0, value: -1 }, { t: 4, value: 1 }],
          },
        }),
      ];
      expect(timelineHasAudioAutomation(clips)).toBe(true);
      const schedule = buildAudioSchedule(clips, [], []);
      expect(schedule[0].volumeAutomation).toHaveLength(2);
      expect(schedule[0].panAutomation).toHaveLength(2);
      expect(schedule[0].volume).toBe(0.8);
    });

    it('applyGainEnvelope matches schedule automation defaults', () => {
      class FakeAudioParam {
        events: Array<{ type: string; value?: number; time: number }> = [];
        cancelScheduledValues(time: number) {
          this.events.push({ type: 'cancel', time });
        }
        setValueAtTime(value: number, time: number) {
          this.events.push({ type: 'set', value, time });
          return this;
        }
        linearRampToValueAtTime(value: number, time: number) {
          this.events.push({ type: 'ramp', value, time });
          return this;
        }
      }
      const param = new FakeAudioParam();
      const clips = [
        makeClip('a', 2, {
          automation: {
            volume: [
              { t: 0, value: 1 },
              { t: 1, value: 0.25 },
            ],
          },
        }),
      ];
      const [entry] = buildAudioSchedule(clips, [], []);
      applyGainEnvelope(
        param as unknown as AudioParam,
        entry,
        0,
        entry.duration,
        0,
        0,
      );
      expect(param.events.some((e) => e.type === 'ramp' && e.value === 0.25)).toBe(
        true,
      );
    });
  });

  describe('media-engine fallback', () => {
    it('keeps volume/pan automation on OfflineAudioContext only without WASM', async () => {
      const curves = [{ volumeAutomation: [{ t: 0, value: 1 }], panAutomation: [] }];
      expect(scheduleNeedsOfflineAudioMix(curves)).toBe(true);
      expect(scheduleNeedsOfflineAudioMix([{}])).toBe(false);
      await loadMediaEngineModule({ baseUrl: WASM_BASE });
      expect(scheduleNeedsOfflineAudioMix(curves)).toBe(false);
    });

    it('premixes volume + pan keyframes through WASM, not OfflineAudioContext', async () => {
      await loadMediaEngineModule({ baseUrl: WASM_BASE });
      const offline = stubOfflineAudioContext();
      const source = new Float32Array(48_000).fill(0.5);
      const cache = { get: async () => fakeAudioBuffer([source]), delete: () => {} };
      const volumeAutomation = [
        { t: 0, value: 0.25 },
        { t: 1, value: 1.5 },
      ];
      const panAutomation = [
        { t: 0, value: -1 },
        { t: 1, value: 1 },
      ];
      const entry = scheduleEntry({ volumeAutomation, panAutomation });

      const mixed = await renderTimelineAudioMix([entry], 1, cache as never);

      expect(offline.startRenderingCalls()).toBe(0);
      // Decode context only — no 1-second (or 2-hour) render graph.
      expect(offline.lengths).toEqual([1]);
      expect(getLastMediaEngineMixBackend()).toBe('wasm');
      const left = mixed.getChannelData(0);
      const right = mixed.getChannelData(1);
      for (const frame of [4_800, 24_000, 43_200]) {
        const t = frame / 48_000;
        const gain = sampleKeyframes(volumeAutomation, t, 1);
        const x = (sampleKeyframes(panAutomation, t, 0) + 1) / 2; // mono source → StereoPanner law
        expect(left[frame]).toBeCloseTo(0.5 * gain * Math.cos((x * Math.PI) / 2), 6);
        expect(right[frame]).toBeCloseTo(0.5 * gain * Math.sin((x * Math.PI) / 2), 6);
      }
    });

    it('streams a >45 minute schedule straight into AAC frames', async () => {
      await loadMediaEngineModule({ baseUrl: WASM_BASE });
      const offline = stubOfflineAudioContext();
      const encoded: Array<{ timestamp: number; numberOfFrames: number; peak: number }> = [];
      class FakeAudioData {
        constructor(readonly init: { timestamp: number; numberOfFrames: number; data: Float32Array }) {}
        close() {}
      }
      vi.stubGlobal('AudioData', FakeAudioData);
      vi.stubGlobal('AudioEncoder', class {
        constructor(private readonly init: { output: (chunk: unknown) => void }) {}
        configure() {}
        encode(data: FakeAudioData) {
          let peak = 0;
          for (const v of data.init.data) peak = Math.max(peak, Math.abs(v));
          encoded.push({ timestamp: data.init.timestamp, numberOfFrames: data.init.numberOfFrames, peak });
          this.init.output({ timestamp: data.init.timestamp });
        }
        async flush() {}
        close() {}
      });

      const durationSec = MAX_OFFLINE_AUDIO_SECONDS + 60;
      const tone = new Float32Array(48_000);
      for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48_000);
      const decoded: string[] = [];
      const cache = {
        get: async (clipId: string) => {
          decoded.push(clipId);
          return fakeAudioBuffer([tone, tone]);
        },
        delete: () => {},
      };
      const entries = [
        scheduleEntry({ clipId: 'intro', timelineStart: 10 }),
        scheduleEntry({ clipId: 'outro', timelineStart: durationSec - 2 }),
      ];

      const result = await encodeScheduleAudioStreaming(entries, durationSec, { cache: cache as never });

      expect(result).not.toBeNull();
      const totalFrames = durationSec * 48_000;
      expect(encoded).toHaveLength(Math.ceil(totalFrames / AAC_FRAME_SAMPLES));
      expect(result!.chunks).toHaveLength(encoded.length);
      expect(offline.startRenderingCalls()).toBe(0);
      expect(offline.lengths).toEqual([1]);
      expect(decoded).toEqual(['intro', 'outro']);
      // Timestamps come from absolute frame positions — no per-frame rounding drift.
      const last = encoded[encoded.length - 1]!;
      expect(last.timestamp).toBe(
        Math.round(((encoded.length - 1) * AAC_FRAME_SAMPLES * 1_000_000) / 48_000),
      );
      const frameAt = (sec: number) => encoded[Math.floor((sec * 48_000) / AAC_FRAME_SAMPLES)]!;
      expect(frameAt(10.5).peak).toBeGreaterThan(0.5);
      expect(frameAt(durationSec - 1.5).peak).toBeGreaterThan(0.5);
      expect(frameAt(600).peak).toBe(0);
    });

    it('does not stream when ?no_media_engine is set', async () => {
      await loadMediaEngineModule({ baseUrl: WASM_BASE });
      __setMediaEngineKillSwitchForTests(true);
      stubOfflineAudioContext();
      expect(await prepareStreamingAudioMix()).toBe(false);
      const cache = { get: async () => fakeAudioBuffer([new Float32Array(10)]), delete: () => {} };
      await expect(
        encodeScheduleAudioStreaming([scheduleEntry({})], 1, { cache: cache as never }),
      ).resolves.toBeNull();
    });

    it('still mixes via OfflineAudioContext when WASM mix is disabled', async () => {
      __setMediaEngineKillSwitchForTests(true);

      const rendered = {
        length: 48_000,
        numberOfChannels: 2,
        sampleRate: 48_000,
        getChannelData: () => new Float32Array(48_000),
      } as unknown as AudioBuffer;

      let startRenderingCalls = 0;
      class FakeOfflineAudioContext {
        destination = {};
        sampleRate = 48_000;
        createBufferSource() {
          return {
            buffer: null as AudioBuffer | null,
            playbackRate: { value: 1 },
            connect() {},
            start() {},
          };
        }
        createGain() {
          return {
            gain: {
              cancelScheduledValues() {},
              setValueAtTime() {},
              linearRampToValueAtTime() {},
            },
            connect() {},
          };
        }
        createStereoPanner() {
          return {
            pan: {
              cancelScheduledValues() {},
              setValueAtTime() {},
            },
            connect() {},
          };
        }
        async startRendering() {
          startRenderingCalls += 1;
          return rendered;
        }
      }
      vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);

      const entry = {
        clipId: 'a',
        objectUrl: 'blob:a',
        timelineStart: 0,
        duration: 1,
        cycleDuration: 1,
        loopCount: 1,
        bufferOffset: 0,
        volume: 1,
        audioFadeIn: 0,
        audioFadeOut: 0,
        playbackRate: 1,
      } as AudioScheduleEntry;

      const cache = {
        get: async () =>
          ({
            length: 48_000,
            numberOfChannels: 2,
            sampleRate: 48_000,
            getChannelData: () => new Float32Array(48_000),
          }) as unknown as AudioBuffer,
      };

      const mixed = await renderTimelineAudioMix(
        [entry],
        1,
        cache as never,
      );
      expect(startRenderingCalls).toBe(1);
      expect(mixed).toBe(rendered);
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
