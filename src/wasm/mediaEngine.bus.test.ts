/**
 * Lane buses and loudness normalization on the export premix, through the
 * shipped `media_engine.wasm` — the same stream / pass helpers the export
 * uses (`exportAudioBus.ts`), with the delivered audio re-measured by an
 * independent meter instance (`media_engine_fx.wasm`'s `loudness_meter_*`).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Track } from '../types';
import { createBusEffect, type MasterBusSettings } from '../utils/audioBus';
import { planBusGraph, type BusGraphPlan } from '../audio/fxGraph';
import {
  engineReport,
  finalExportPass,
  loudnessGainDb,
  measureStream,
  measuringExportPass,
  type ExportAudioBus,
  type ExportMixPass,
} from '../utils/exportAudioBus';
import {
  _resetMediaEngineLoadStateForTests,
  openTimelineMixStream,
  type ClipPcm,
  type MediaEngineMixEntry,
} from './mediaEngine';

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
});

beforeEach(() => {
  _resetMediaEngineLoadStateForTests();
});

/** Integrated loudness and true peak of interleaved stereo, measured independently. */
function measure(interleaved: Float32Array): { integrated: number; truePeak: number } {
  const ex = meterExports;
  const tail = RATE / 10; // flush the true-peak detector's look-ahead
  const frames = interleaved.length / 2 + tail;
  const ptr = ex.malloc(frames * 8);
  const out = ex.malloc(6 * 8);
  const heap = new Float32Array(ex.memory.buffer, ptr, frames * 2);
  heap.fill(0);
  heap.set(interleaved);
  const meter = ex.loudness_meter_create(RATE, 2);
  ex.loudness_meter_process(meter, ptr, frames);
  ex.loudness_meter_read(meter, out, 6);
  const values = new Float64Array(ex.memory.buffer, out, 6).slice();
  ex.loudness_meter_destroy(meter);
  ex.free(ptr);
  ex.free(out);
  return { integrated: values[2]!, truePeak: values[4]! };
}

let seed = 7;
function noise(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
}

function programme(seconds: number, level: number, salt: number): ClipPcm {
  seed = 99 + salt;
  const n = Math.round(seconds * RATE);
  const planes = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 0.25 * t));
    for (let c = 0; c < 2; c++) {
      const v =
        0.5 * Math.sin(2 * Math.PI * (110 * (salt + 1) + c) * t) +
        0.2 * Math.sin(2 * Math.PI * 2400 * t) +
        0.3 * (t % 0.4 < 0.03 ? 1 : 0.15) * noise();
      planes[c]![i] = level * env * v;
    }
  }
  return { sampleRate: RATE, channelData: planes };
}

const tracks = (): Track[] => [
  { id: 'dialogue', kind: 'video', items: [], audioFx: [createBusEffect('compressor')] },
  {
    id: 'music',
    kind: 'audio',
    items: [],
    duck: { sourceTrackId: 'dialogue', depthDb: 9, thresholdDb: -40, attack: 0.05, hold: 0.2, release: 0.5 },
  },
];

function entries(plan: BusGraphPlan | null, seconds: number): MediaEngineMixEntry[] {
  return ['dialogue', 'music'].map((id) => ({
    clipId: id,
    timelineStart: 0,
    duration: seconds,
    bufferOffset: 0,
    volume: 1,
    audioFadeIn: 0.01,
    audioFadeOut: 0.01,
    ...(plan ? { bus: plan.laneIndex.get(id)! } : {}),
  }));
}

async function mix(pass: ExportMixPass, pcm: Record<string, ClipPcm>, seconds: number) {
  const stream = await openTimelineMixStream(entries(pass.bus, seconds), pcm, {
    baseUrl: WASM_BASE,
    sampleRate: RATE,
    durationSec: seconds,
    chunkFrames: 40_000,
    limiter: pass.limiter,
    bus: pass.bus,
    meter: pass.meter,
  });
  expect(stream).not.toBeNull();
  const out = new Float32Array(stream!.totalFrames * 2);
  try {
    for await (const chunk of stream!) out.set(chunk.frames, chunk.startFrame * 2);
    return { out, meters: stream!.readMeters() };
  } finally {
    stream!.close();
  }
}

describe('export premix: lane buses', () => {
  it('without bus settings the mix is byte-identical to the plain premix', async () => {
    const seconds = 3;
    const pcm = { dialogue: programme(seconds, 0.4, 0), music: programme(seconds, 0.4, 1) };
    const plain = await mix({ bus: null, meter: false, limiter: null }, pcm, seconds);
    // Dry lanes: no graph is created at all.
    const dry: ExportAudioBus = { tracks: [{ id: 'dialogue', kind: 'video', items: [] }, { id: 'music', kind: 'audio', items: [] }] };
    const pass = finalExportPass(dry, null);
    expect(pass.bus).toBeNull();
    const viaHelpers = await mix(pass, pcm, seconds);
    expect(Buffer.from(viaHelpers.out.buffer).equals(Buffer.from(plain.out.buffer))).toBe(true);
    // Even a metered graph over dry lanes delivers the same samples.
    const metered = await mix({ bus: planBusGraph(dry.tracks, undefined), meter: true, limiter: null }, pcm, seconds);
    expect(Buffer.from(metered.out.buffer).equals(Buffer.from(plain.out.buffer))).toBe(true);
    expect(metered.meters!.integrated).toBeGreaterThan(-30);
  }, 60_000);

  it('a -14 LUFS target lands within 0.5 LU and under -1 dBTP', async () => {
    const seconds = 20;
    // Quiet sources: normalization has to add gain, and the limiter has work to do.
    const pcm = { dialogue: programme(seconds, 0.12, 0), music: programme(seconds, 0.1, 1) };
    for (const target of [-14, -16, -23]) {
      const master: MasterBusSettings = {
        fx: [createBusEffect('eq')],
        loudness: { targetLufs: target, truePeakDb: -1 },
      };
      const bus: ExportAudioBus = { tracks: tracks(), masterBus: master };

      const metering = await openTimelineMixStream(entries(measuringExportPass(bus).bus, seconds), pcm, {
        baseUrl: WASM_BASE,
        sampleRate: RATE,
        durationSec: seconds,
        chunkFrames: 40_000,
        bus: measuringExportPass(bus).bus,
        meter: true,
      });
      const measured = await measureStream(metering!);
      expect(Number.isFinite(measured)).toBe(true);
      const gainDb = loudnessGainDb(master.loudness!, measured);

      const delivered = await mix(finalExportPass(bus, null, gainDb), pcm, seconds);
      const independent = measure(delivered.out);
      expect(Math.abs(independent.integrated - target)).toBeLessThanOrEqual(0.5);
      expect(independent.truePeak).toBeLessThanOrEqual(-1);
      // The stream's own output meter agrees with the independent one.
      expect(delivered.meters!.integrated).toBeCloseTo(independent.integrated, 1);

      const report = engineReport(bus, measured, gainDb, delivered.meters);
      expect(report.audioFx).toBe('engine');
      expect(report.loudness).toMatchObject({ targetLufs: target, measuredLufs: measured, gainDb });
    }
  }, 120_000);

  it('routes lanes: the duck pulls the music lane down under dialogue', async () => {
    const seconds = 4;
    const dialogue = programme(seconds, 0.4, 0);
    // Dialogue only in the second half.
    for (const plane of dialogue.channelData) plane.fill(0, 0, 2 * RATE);
    const music = programme(seconds, 0.3, 1);
    const bus: ExportAudioBus = { tracks: tracks() };
    const ducked = await mix(finalExportPass(bus, null), { dialogue, music }, seconds);
    const undisturbed = await mix(
      finalExportPass({ tracks: [tracks()[0]!, { id: 'music', kind: 'audio', items: [] }] }, null),
      { dialogue, music },
      seconds,
    );
    const rms = (x: Float32Array, from: number, to: number) => {
      let s = 0;
      for (let i = from * RATE * 2; i < to * RATE * 2; i++) s += x[i]! ** 2;
      return Math.sqrt(s / ((to - from) * RATE * 2));
    };
    // Before the dialogue: identical. After: quieter by roughly the duck depth.
    expect(rms(ducked.out, 0.5, 1.9)).toBeCloseTo(rms(undisturbed.out, 0.5, 1.9), 6);
    expect(rms(ducked.out, 2.5, 3.9)).toBeLessThan(rms(undisturbed.out, 2.5, 3.9));
  }, 60_000);
});
