/**
 * Output taps (stems) on the export premix, through the shipped
 * `media_engine.wasm` and the TS stream: the taps sum back to the master,
 * chunking changes nothing, tapping changes nothing about the master, the
 * taps stay aligned through the master's look-ahead, and each tap's meter
 * reads what an independent meter (`media_engine_fx.wasm`) reads.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Track } from '../types';
import { createBusEffect, type BusEffect, type MasterBusSettings } from '../audio/audioBus';
import { planBusGraph, type BusGraphPlan } from '../audio/fxGraph';
import {
  _resetMediaEngineLoadStateForTests,
  openTimelineMixStream,
  type ClipPcm,
  type MediaEngineMixEntry,
  type TimelineMixStreamOptions,
} from './mediaEngine';
import { MIX_METER, packTruePeakLimiterRow } from './mediaEngineLayout';
import { collectTapped, sameBits, worstSumUlps, type TappedMix } from './mediaEngineTaps.test.helpers';

const ROOT = process.cwd();
const WASM_BASE = pathToFileURL(path.resolve(ROOT, 'public/wasm') + path.sep).href;
const RATE = 48000;

interface MeterExports {
  memory: WebAssembly.Memory;
  malloc(bytes: number): number;
  free(ptr: number): void;
  loudness_meter_create(rate: number, channels: number): number;
  loudness_meter_process(meter: number, ptr: number, frames: number): number;
  loudness_meter_read(meter: number, out: number, capacity: number): number;
  loudness_meter_destroy(meter: number): void;
}

let meterExports: MeterExports;

beforeAll(async () => {
  const module = await WebAssembly.compile(readFileSync(path.resolve(ROOT, 'public/wasm/media_engine_fx.wasm')));
  const instance = await WebAssembly.instantiate(module, { env: { emscripten_notify_memory_growth() {} } });
  meterExports = instance.exports as unknown as MeterExports;
  (instance.exports as { _initialize?: () => void })._initialize?.();
});

beforeEach(() => {
  _resetMediaEngineLoadStateForTests();
});

/** The `MIX_METER` readout of interleaved stereo, measured by a separate meter on exactly these frames. */
function independentMeter(interleaved: Float32Array): Float64Array {
  const ex = meterExports;
  const ptr = ex.malloc(interleaved.length * 4);
  const out = ex.malloc(6 * 8);
  new Float32Array(ex.memory.buffer, ptr, interleaved.length).set(interleaved);
  const meter = ex.loudness_meter_create(RATE, 2);
  ex.loudness_meter_process(meter, ptr, interleaved.length / 2);
  ex.loudness_meter_read(meter, out, 6);
  const values = new Float64Array(ex.memory.buffer, out, 6).slice();
  ex.loudness_meter_destroy(meter);
  ex.free(ptr);
  ex.free(out);
  return values;
}

let seed = 3;
function noise(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
}

/** Busy stereo material: tones, noise bursts, and (with `pauses`) gaps for the duck and the meters' gates. */
function programme(seconds: number, level: number, salt: number, pauses = false): ClipPcm {
  seed = 500 + salt;
  const n = Math.round(seconds * RATE);
  const planes = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 0.3 * t));
    const gap = pauses && t % 1.5 > 1.0 ? 0.001 : 1;
    planes.forEach((plane, c) => {
      plane[i] =
        level *
        env *
        gap *
        (0.5 * Math.sin(2 * Math.PI * (150 * (salt + 1) + c) * t) +
          0.2 * Math.sin(2 * Math.PI * 3100 * t) +
          0.3 * (t % 0.4 < 0.03 ? 1 : 0.15) * noise());
    });
  }
  return { sampleRate: RATE, channelData: planes };
}

/** Silence with one impulse of `level` at `frame` on both channels. */
function impulse(seconds: number, frame: number, level: number): ClipPcm {
  const planes = [new Float32Array(seconds * RATE), new Float32Array(seconds * RATE)];
  for (const plane of planes) plane[frame] = level;
  return { sampleRate: RATE, channelData: planes };
}

function limiterAt(ceilingDb: number): BusEffect {
  const effect = createBusEffect('limiter');
  return effect.kind === 'limiter' ? { ...effect, ceilingDb } : effect;
}

/** Dialogue (compressor + lane limiter), music (EQ, ducked under dialogue), a dry lane and a titles lane. */
function stemTracks(): Track[] {
  return [
    { id: 'dialogue', kind: 'video', items: [], audioFx: [createBusEffect('compressor'), limiterAt(-3)] },
    {
      id: 'music',
      kind: 'audio',
      items: [],
      audioFx: [createBusEffect('eq')],
      duck: { sourceTrackId: 'dialogue', depthDb: 9, thresholdDb: -40, attack: 0.05, hold: 0.2, release: 0.5 },
    },
    { id: 'fx', kind: 'audio', items: [] },
    { id: 'titles', kind: 'text', items: [] },
  ];
}

const LANES = ['dialogue', 'music', 'fx'];

/** One whole clip per lane, plus `narration` routed to no lane (the direct input). */
function entries(plan: BusGraphPlan, seconds: number): MediaEngineMixEntry[] {
  return [...LANES, 'narration'].map((id) => {
    const lane = plan.laneIndex.get(id);
    return {
      clipId: id,
      timelineStart: 0,
      duration: seconds,
      bufferOffset: 0,
      volume: 1,
      audioFadeIn: 0,
      audioFadeOut: 0,
      ...(lane === undefined ? {} : { bus: lane }),
    };
  });
}

interface Sources extends Record<string, ClipPcm> {
  dialogue: ClipPcm;
  music: ClipPcm;
  fx: ClipPcm;
  narration: ClipPcm;
}

function sources(seconds: number): Sources {
  return {
    dialogue: programme(seconds, 0.5, 0, true),
    music: programme(seconds, 0.6, 1),
    fx: programme(seconds, 0.2, 2),
    narration: programme(seconds, 0.25, 3),
  };
}

async function mix(
  plan: BusGraphPlan,
  pcm: Record<string, ClipPcm>,
  seconds: number,
  extra: Partial<TimelineMixStreamOptions> = {},
): Promise<TappedMix> {
  const stream = await openTimelineMixStream(entries(plan, seconds), pcm, {
    baseUrl: WASM_BASE,
    sampleRate: RATE,
    durationSec: seconds,
    chunkFrames: 40_000,
    bus: plan,
    ...extra,
  });
  expect(stream).not.toBeNull();
  return collectTapped(stream!);
}

function energy(x: Float32Array): number {
  let e = 0;
  for (const v of x) e += v * v;
  return e;
}

function peak(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

describe('export premix: output taps (stems)', () => {
  it('every lane plus the direct input sum back to the master within 1 ulp, chunked or whole', async () => {
    const seconds = 4;
    const pcm = sources(seconds);
    const plan = planBusGraph(stemTracks(), undefined, { tapTrackIds: LANES, tapDirect: true });
    expect(plan.tapTrackIds).toEqual(LANES);

    const chunked = await mix(plan, pcm, seconds, { meterTaps: true });
    expect(chunked.taps).toHaveLength(4);
    expect(worstSumUlps(chunked.out, chunked.taps)).toBeLessThanOrEqual(1);
    for (const tap of chunked.taps) expect(energy(tap)).toBeGreaterThan(1);
    // Post-chain: the dialogue stem never passes its lane limiter's -3 dB ceiling.
    expect(peak(chunked.taps[0]!)).toBeLessThanOrEqual(10 ** (-3 / 20) * 1.0001);

    const whole = await mix(plan, pcm, seconds, { chunkFrames: seconds * RATE, meterTaps: true });
    expect(sameBits(whole.out, chunked.out)).toBe(true);
    whole.taps.forEach((tap, t) => expect(sameBits(tap, chunked.taps[t]!)).toBe(true));
    expect(whole.tapMeters).toEqual(chunked.tapMeters);

    // Tapping never changes the master.
    const untapped = await mix(planBusGraph(stemTracks(), undefined), pcm, seconds);
    expect(untapped.taps).toEqual([]);
    expect(sameBits(untapped.out, chunked.out)).toBe(true);
  }, 60_000);

  it('each tap meter reads what an independent meter reads from that stem', async () => {
    const seconds = 6;
    const plan = planBusGraph(stemTracks(), undefined, { tapTrackIds: LANES, tapDirect: true });
    const tapped = await mix(plan, sources(seconds), seconds, { meterTaps: true, meter: true });
    expect(tapped.tapMeters?.map((m) => m.trackId)).toEqual([...LANES, null]);
    tapped.taps.forEach((tap, t) => {
      const reading = tapped.tapMeters![t]!;
      const want = independentMeter(tap);
      expect(Number.isFinite(reading.integrated)).toBe(true);
      expect(reading.integrated).toBe(want[MIX_METER.integrated]);
      expect(reading.range).toBe(want[MIX_METER.range]);
      expect(reading.truePeak).toBe(want[MIX_METER.truePeak]);
      expect(reading.samplePeak).toBe(want[MIX_METER.samplePeak]);
    });
    expect(Number.isFinite(tapped.meters!.integrated)).toBe(true);
  }, 60_000);

  it('taps stay frame-aligned with the master through the master limiter and final stage', async () => {
    const seconds = 1;
    const tracks: Track[] = [
      { id: 'a', kind: 'video', items: [], audioFx: [limiterAt(0)] },
      { id: 'b', kind: 'audio', items: [] },
    ];
    const master: MasterBusSettings = { fx: [limiterAt(-1)] };
    const plan = planBusGraph(tracks, master, {
      finalRows: packTruePeakLimiterRow(-1),
      tapTrackIds: ['a', 'b'],
      tapDirect: true,
    });
    expect([plan.masterCount, plan.finalCount]).toEqual([1, 1]);
    const at = { a: 4000, b: 123, narration: 30_001 };
    const level = { a: 0.125, b: 0.25, narration: 0.0625 };
    const pcm = {
      a: impulse(seconds, at.a, level.a),
      b: impulse(seconds, at.b, level.b),
      narration: impulse(seconds, at.narration, level.narration),
    };
    const stream = await openTimelineMixStream(
      (['a', 'b', 'narration'] as const).map((id) => ({
        clipId: id,
        timelineStart: 0,
        duration: seconds,
        bufferOffset: 0,
        volume: 1,
        audioFadeIn: 0,
        audioFadeOut: 0,
        ...(plan.laneIndex.has(id) ? { bus: plan.laneIndex.get(id)! } : {}),
      })),
      pcm,
      { baseUrl: WASM_BASE, sampleRate: RATE, durationSec: seconds, chunkFrames: 7000, bus: plan },
    );
    const { out, taps } = await collectTapped(stream!);
    expect(taps).toHaveLength(3);
    (['a', 'b', 'narration'] as const).forEach((id, t) => {
      // Limiters are bit-transparent below their ceilings: the impulse arrives intact.
      expect(out[2 * at[id]]).toBe(level[id]);
      const tap = taps[t]!;
      for (let i = 0; i < tap.length; i += 2) {
        if (tap[i] !== 0) expect([i / 2, tap[i]]).toEqual([at[id], level[id]]);
      }
      expect(tap[2 * at[id]]).toBe(level[id]);
    });
  }, 30_000);

  it('a dry project still taps: the stems sum to the master, which matches the untapped mix', async () => {
    const seconds = 2;
    const pcm = sources(seconds);
    const dry: Track[] = LANES.map((id, i) => ({ id, kind: i === 0 ? 'video' : 'audio', items: [] }));
    const plan = planBusGraph(dry, undefined, { tapTrackIds: ['music'], tapDirect: true });
    expect(plan.processing).toBe(false);
    const tapped = await mix(plan, pcm, seconds);
    expect(tapped.taps).toHaveLength(2);
    // The untapped dry mix runs no graph at all; the tapped one sums the same lanes.
    const plain = await mix(planBusGraph(dry, undefined), pcm, seconds);
    expect(worstSumUlps(plain.out, [tapped.out])).toBeLessThanOrEqual(1);
    // Stems for music and direct only: the master minus both is the dialogue and fx lanes.
    const [music, direct] = tapped.taps;
    let residual = 0;
    for (let i = 0; i < tapped.out.length; i++) {
      const c = i % 2;
      const frame = i >> 1;
      const rest = (pcm.dialogue.channelData[c]?.[frame] ?? 0) + (pcm.fx.channelData[c]?.[frame] ?? 0);
      const stems = (music?.[i] ?? NaN) + (direct?.[i] ?? NaN);
      residual = Math.max(residual, Math.abs((tapped.out[i] ?? NaN) - stems - rest));
    }
    expect(residual).toBeLessThan(1e-6);
  }, 30_000);

  it('an untapped plan carries no taps and reads no tap meters', async () => {
    const seconds = 1;
    const plan = planBusGraph(stemTracks(), undefined);
    const stream = await openTimelineMixStream(entries(plan, seconds), sources(seconds), {
      baseUrl: WASM_BASE,
      sampleRate: RATE,
      durationSec: seconds,
      bus: plan,
      meterTaps: true,
    });
    const chunk = await stream!.next();
    expect(chunk?.taps).toBeUndefined();
    expect(stream!.readTapMeters()).toBeNull();
    stream!.close();
  });
});
