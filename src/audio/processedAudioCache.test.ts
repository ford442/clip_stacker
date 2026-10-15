import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ProcessedAudioCache } from './processedAudioCache';
import type { AudioScheduleEntry } from './schedule';
import {
  __setMediaEngineKillSwitchForTests,
  _resetMediaEngineLoadStateForTests,
  loadMediaEngineModule,
} from '../wasm/mediaEngine';
import { applyInsertChainToPcm } from '../wasm/mediaEngineInsertChain';
import type { ClipAudioEffects } from '../utils/audioEffects';

const WASM_BASE = pathToFileURL(path.resolve(process.cwd(), 'public/wasm') + path.sep).href;
const RATE = 48_000;

function fakeBuffer(channels: Float32Array[], sampleRate = RATE): AudioBuffer {
  return {
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    sampleRate,
    duration: channels[0]!.length / sampleRate,
    getChannelData: (ch: number) => channels[ch]!,
    copyToChannel: (data: Float32Array, ch: number) => channels[ch]!.set(data),
  } as unknown as AudioBuffer;
}

const ctx = {
  createBuffer: (channels: number, length: number, sampleRate: number) =>
    fakeBuffer(Array.from({ length: channels }, () => new Float32Array(length)), sampleRate),
} as unknown as BaseAudioContext;

const BOOST: ClipAudioEffects = {
  eq: [{ type: 'peaking', frequency: 1000, gainDb: 6, q: 1, enabled: true }],
};

function entry(overrides: Partial<AudioScheduleEntry> = {}): AudioScheduleEntry {
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

function tone(seconds = 1, channels = 2): AudioBuffer {
  const planes = Array.from({ length: channels }, () => {
    const plane = new Float32Array(Math.floor(RATE * seconds));
    for (let i = 0; i < plane.length; i++) plane[i] = 0.25 * Math.sin((2 * Math.PI * 1000 * i) / RATE);
    return plane;
  });
  return fakeBuffer(planes);
}

describe('ProcessedAudioCache', () => {
  afterEach(() => _resetMediaEngineLoadStateForTests());

  it('returns the dry buffer when no block is enabled', async () => {
    const cache = new ProcessedAudioCache();
    const source = tone();
    expect(await cache.get(entry(), source, ctx)).toBe(source);
    expect(await cache.get(entry({ audioEffects: { eq: [{ ...BOOST.eq![0]!, enabled: false }] } }), source, ctx)).toBe(
      source,
    );
    expect(cache.size).toBe(0);
  });

  it('runs the media-engine chain from the trim start and caches by settings', async () => {
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
    const cache = new ProcessedAudioCache();
    const source = tone();
    const trimmed = entry({ audioEffects: BOOST, bufferOffset: 0.25 });
    const processed = await cache.get(trimmed, source, ctx);
    expect(processed).not.toBe(source);
    // Untouched before the trim start; the chain's output after it.
    const start = 0.25 * RATE;
    expect(processed.getChannelData(0).subarray(0, start)).toEqual(source.getChannelData(0).subarray(0, start));
    const expected = [new Float32Array(source.getChannelData(0))];
    applyInsertChainToPcm(expected, RATE, BOOST, { startFrame: start });
    expect(processed.getChannelData(0)).toEqual(expected[0]);
    // The source buffer is never modified in place.
    expect(source.getChannelData(0)[RATE - 1]).toBeCloseTo(0.25 * Math.sin((2 * Math.PI * 1000 * (RATE - 1)) / RATE), 6);

    expect(await cache.get(trimmed, source, ctx)).toBe(processed);
    const edited = await cache.get({ ...trimmed, audioEffects: { eq: [{ ...BOOST.eq![0]!, gainDb: 3 }] } }, source, ctx);
    expect(edited).not.toBe(processed);
    cache.prune(new Set());
    expect(cache.size).toBe(0);
  });

  it('plays dry with ?no_media_engine instead of approximating the chain', async () => {
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
    __setMediaEngineKillSwitchForTests(true);
    const cache = new ProcessedAudioCache();
    const source = tone();
    expect(await cache.get(entry({ audioEffects: BOOST }), source, ctx)).toBe(source);
  });
});
