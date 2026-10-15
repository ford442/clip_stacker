import { beforeEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  MIX_FX_STRIDE,
  __setMediaEngineKillSwitchForTests,
  _resetMediaEngineLoadStateForTests,
  applyInsertChainToPcm,
  loadMediaEngineModule,
  mixTimelineAudio,
  openTimelineMixStream,
  packAudioEffectRows,
  packLimiterRow,
  type ClipPcm,
  type MediaEngineMixEntry,
} from './mediaEngine';
import type { ClipAudioEffects, MasterLimiterSettings } from '../utils/audioEffects';

const WASM_BASE = pathToFileURL(path.resolve(process.cwd(), 'public/wasm') + path.sep).href;
const SAMPLE_RATE = 48000;

function tone(freq: number, seconds: number, amplitude: number, channels = 1): ClipPcm {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i++) plane[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE + c);
    channelData.push(plane);
  }
  return { sampleRate: SAMPLE_RATE, channelData };
}

/** Least-squares amplitude of `freq` in the left channel over `[first, first + count)`. */
function toneAmplitude(interleaved: Float32Array, freq: number, first: number, count: number): number {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  let s = 0;
  let c = 0;
  for (let i = first; i < first + count; i++) {
    s += interleaved[i * 2]! * Math.sin(w * i);
    c += interleaved[i * 2]! * Math.cos(w * i);
  }
  return (2 / count) * Math.hypot(s, c);
}

function entry(overrides: Partial<MediaEngineMixEntry> = {}): MediaEngineMixEntry {
  return {
    clipId: 'a',
    timelineStart: 0,
    duration: 1,
    bufferOffset: 0,
    volume: 1,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

const BOOST: ClipAudioEffects = {
  eq: [{ type: 'peaking', frequency: 1000, gainDb: 6, q: 1, enabled: true }],
};

const LIMITER: MasterLimiterSettings = { enabled: true, ceilingDb: -1, lookahead: 0.005, release: 0.08 };

async function mixInChunks(
  schedule: MediaEngineMixEntry[],
  pcm: Record<string, ClipPcm>,
  durationSec: number,
  chunkFrames: number,
  limiter?: MasterLimiterSettings,
): Promise<Float32Array> {
  const stream = await openTimelineMixStream(schedule, pcm, {
    baseUrl: WASM_BASE,
    durationSec,
    chunkFrames,
    limiter,
  });
  expect(stream).not.toBeNull();
  const out = new Float32Array(stream!.totalFrames * stream!.channels);
  try {
    for await (const chunk of stream!) out.set(chunk.frames, chunk.startFrame * stream!.channels);
  } finally {
    stream!.close();
  }
  return out;
}

describe('mediaEngine insert effects', () => {
  beforeEach(() => {
    _resetMediaEngineLoadStateForTests();
  });

  it('packs enabled EQ bands, then the compressor, and skips bypassed blocks', () => {
    const rows = packAudioEffectRows({
      eq: [
        { type: 'lowShelf', frequency: 120, gainDb: 3, q: 0.7, enabled: true },
        { type: 'peaking', frequency: 900, gainDb: -4, q: 2, enabled: false },
        { type: 'highPass', frequency: 60, gainDb: 0, q: 0.7, enabled: true },
      ],
      compressor: {
        enabled: true,
        thresholdDb: -18,
        ratio: 3,
        attack: 0.005,
        release: 0.12,
        kneeDb: 4,
        makeupDb: 2,
      },
    });
    expect(rows).toHaveLength(3 * MIX_FX_STRIDE);
    expect(rows.slice(0, MIX_FX_STRIDE)).toEqual([2, 1, 120, 3, 0.7, 0, 0, 0, 0, 0]);
    expect(rows.slice(MIX_FX_STRIDE, 2 * MIX_FX_STRIDE)).toEqual([4, 1, 60, 0, 0.7, 0, 0, 0, 0, 0]);
    expect(rows.slice(2 * MIX_FX_STRIDE)).toEqual([5, 1, 0, 2, 0, -18, 3, 0.005, 0.12, 4]);
    expect(
      packAudioEffectRows({
        eq: [{ type: 'peaking', frequency: 900, gainDb: -4, q: 2, enabled: false }],
        compressor: { enabled: false, thresholdDb: -18, ratio: 3, attack: 0.005, release: 0.12, kneeDb: 4, makeupDb: 2 },
      }),
    ).toEqual([]);
    expect(packLimiterRow(LIMITER)).toEqual([6, 1, 0, 0, 0, -1, 0, 0.005, 0.08, 0]);
    expect(packLimiterRow({ ...LIMITER, enabled: false })).toEqual([]);
  });

  it('a +6 dB peaking EQ at 1 kHz lifts the exported tone by 6 dB', async () => {
    const pcm = { a: tone(1000, 1.5, 0.25) };
    const dry = await mixTimelineAudio([entry()], pcm, { baseUrl: WASM_BASE, durationSec: 1 });
    const wet = await mixTimelineAudio([entry({ effects: BOOST })], pcm, { baseUrl: WASM_BASE, durationSec: 1 });
    const first = SAMPLE_RATE / 2;
    const gainDb =
      20 * Math.log10(toneAmplitude(wet!.frames, 1000, first, first) / toneAmplitude(dry!.frames, 1000, first, first));
    expect(gainDb).toBeCloseTo(6, 1);
  });

  it('the preview chain produces the samples the export mix hears', async () => {
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
    const pcm = { a: tone(1000, 1.5, 0.25) };
    const offset = 0.25;
    const mixed = await mixTimelineAudio([entry({ effects: BOOST, bufferOffset: offset })], pcm, {
      baseUrl: WASM_BASE,
      durationSec: 1,
    });
    const preview = [new Float32Array(pcm.a.channelData[0]!)];
    const startFrame = offset * SAMPLE_RATE;
    expect(applyInsertChainToPcm(preview, SAMPLE_RATE, BOOST, { startFrame })).toBe(true);
    // Frames before the trim start are untouched.
    expect(preview[0]!.subarray(0, startFrame)).toEqual(pcm.a.channelData[0]!.subarray(0, startFrame));
    const pan = Math.fround(Math.SQRT1_2); // mono source at centre: equal-power -3 dB
    for (let of = 0; of < SAMPLE_RATE; of++) {
      expect(mixed!.frames[of * 2]).toBe(Math.fround(preview[0]![startFrame + of]! * pan));
    }
  });

  it('chunked fx mixes match the whole mix bit for bit, limiter included', async () => {
    const pcm = { a: tone(220, 2, 0.9, 2), b: tone(3100, 2, 0.8, 2) };
    const schedule = [
      entry({
        duration: 1.6,
        volume: 2,
        effects: {
          eq: [{ type: 'lowShelf', frequency: 150, gainDb: 6, q: 0.7, enabled: true }],
          compressor: { enabled: true, thresholdDb: -24, ratio: 4, attack: 0.003, release: 0.1, kneeDb: 6, makeupDb: 6 },
        },
      }),
      entry({ clipId: 'b', timelineStart: 0.4, duration: 1.2, volume: 1.5 }),
    ];
    const whole = await mixInChunks(schedule, pcm, 1.8, 1 << 20, LIMITER);
    for (const chunk of [1024, 777, 12_293]) {
      expect(await mixInChunks(schedule, pcm, 1.8, chunk, LIMITER)).toEqual(whole);
    }
    const ceiling = Math.fround(10 ** (-1 / 20));
    let peak = 0;
    for (const v of whole) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(ceiling);
    expect(peak).toBeGreaterThan(ceiling * 0.97);
  });

  it('no effects and no limiter keep the legacy stateless mix', async () => {
    const pcm = { a: tone(440, 1.2, 0.4, 2) };
    const schedule = [entry({ duration: 1, effects: { eq: [{ ...BOOST.eq![0]!, enabled: false }] } })];
    const bypassed = await mixInChunks(schedule, pcm, 1, 1000, { ...LIMITER, enabled: false });
    const plain = await mixInChunks([entry({ duration: 1 })], pcm, 1, 1 << 20);
    expect(bypassed).toEqual(plain);
  });

  it('?no_media_engine disables inserts along with the mix', async () => {
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
    __setMediaEngineKillSwitchForTests(true);
    const plane = new Float32Array(tone(1000, 0.1, 0.25).channelData[0]!);
    const before = plane.slice();
    expect(applyInsertChainToPcm([plane], SAMPLE_RATE, BOOST)).toBe(false);
    expect(plane).toEqual(before);
    expect(
      await openTimelineMixStream([entry({ effects: BOOST })], { a: tone(1000, 1, 0.25) }, { baseUrl: WASM_BASE }),
    ).toBeNull();
  });
});
