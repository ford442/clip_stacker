/**
 * Preview / export parity for lane buses: the shipped worklet script
 * (`public/worklets/audio-fx-processor.js`) running the shipped
 * `media_engine_fx.wasm` in a stand-in AudioWorkletGlobalScope, against the
 * export premix (`openTimelineMixStream` over `media_engine.wasm`) for the
 * same 10 s of lane audio through the same FX chain.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Track } from '../types';
import { createBusEffect, type BusEffect, type MasterBusSettings } from '../utils/audioBus';
import { planBusGraph, type BusGraphPlan } from '../audio/fxGraph';
import { busLayoutMessage } from './audioFx';
import {
  _resetMediaEngineLoadStateForTests,
  loadMediaEngineModule,
  openTimelineMixStream,
  type ClipPcm,
  type MediaEngineMixEntry,
} from './mediaEngine';

const ROOT = process.cwd();
const WASM_BASE = pathToFileURL(path.resolve(ROOT, 'public/wasm') + path.sep).href;
const RATE = 48000;
const QUANTUM = 128;

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  posted: unknown[];
  postMessage(data: unknown): void;
}

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorClass = new (options: unknown) => Processor;

/** Evaluate the worklet script in a stand-in AudioWorkletGlobalScope; returns its processor class. */
function loadProcessorClass(): ProcessorClass {
  const source = readFileSync(path.resolve(ROOT, 'public/worklets/audio-fx-processor.js'), 'utf8');
  class AudioWorkletProcessor {
    port: FakePort = {
      onmessage: null,
      posted: [],
      postMessage(data: unknown) {
        this.posted.push(data);
      },
    };
  }
  let registered: ProcessorClass | null = null;
  const registerProcessor = (_name: string, cls: ProcessorClass) => {
    registered = cls;
  };
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    AudioWorkletProcessor,
    registerProcessor,
    RATE,
  );
  if (!registered) throw new Error('processor not registered');
  return registered;
}

let fxModule: WebAssembly.Module;
let Processor: ProcessorClass;

beforeAll(async () => {
  fxModule = await WebAssembly.compile(readFileSync(path.resolve(ROOT, 'public/wasm/media_engine_fx.wasm')));
  Processor = loadProcessorClass();
});

beforeEach(() => {
  _resetMediaEngineLoadStateForTests();
});

async function startProcessor(plan: BusGraphPlan, meter = false): Promise<{ proc: Processor; latency: number }> {
  const proc = new Processor({
    numberOfInputs: plan.laneTrackIds.length + 1,
    processorOptions: { module: fxModule, layout: busLayoutMessage(plan, meter) },
  });
  for (let i = 0; i < 200; i++) {
    const ready = proc.port.posted.find((m) => (m as { type?: string }).type === 'ready') as
      | { latency: number }
      | undefined;
    if (ready) return { proc, latency: ready.latency };
    const error = proc.port.posted.find((m) => (m as { type?: string }).type === 'error');
    if (error) throw new Error(JSON.stringify(error));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('worklet never became ready');
}

/** Run planar stereo lanes through the processor in render quanta; returns planar output. */
function runProcessor(proc: Processor, lanes: Float32Array[][], frames: number): Float32Array[] {
  const out = [new Float32Array(frames), new Float32Array(frames)];
  for (let begin = 0; begin < frames; begin += QUANTUM) {
    const n = Math.min(QUANTUM, frames - begin);
    const inputs = lanes.map((lane) => lane.map((plane) => plane.slice(begin, begin + n)));
    inputs.push([]); // the direct input: nothing routed there
    const outputs = [[new Float32Array(n), new Float32Array(n)]];
    expect(proc.process(inputs, outputs)).toBe(true);
    out[0]!.set(outputs[0]![0]!, begin);
    out[1]!.set(outputs[0]![1]!, begin);
  }
  return out;
}

let seed = 1;
function noise(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
}

/** Ten seconds of busy stereo material per lane: tones, bursts, pauses. */
function laneSignal(seconds: number, level: number, salt: number, pauses = false): Float32Array[] {
  seed = 1000 + salt;
  const n = Math.round(seconds * RATE);
  const planes = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * (0.3 + salt * 0.1) * t);
    const gap = pauses && t % 1.6 > 1.1 ? 0.001 : 1;
    for (let c = 0; c < 2; c++) {
      const v =
        0.4 * Math.sin(2 * Math.PI * (180 + 40 * salt + c) * t) +
        0.25 * Math.sin(2 * Math.PI * 4500 * t) +
        0.3 * (t % 0.5 < 0.04 ? 1 : 0.2) * noise();
      planes[c]![i] = level * env * gap * v;
    }
  }
  return planes;
}

function track(id: string, kind: Track['kind'], extra: Partial<Track> = {}): Track {
  return { id, kind, items: [], ...extra };
}

function withParams<T extends BusEffect>(effect: T, patch: Partial<T>): T {
  return { ...effect, ...patch };
}

/** Dialogue / music / effects lanes with every bus effect kind and a duck. */
function fullChainProject(): { tracks: Track[]; masterBus: MasterBusSettings } {
  const eq = createBusEffect('eq');
  const dialogueFx: BusEffect[] = [
    eq,
    withParams(createBusEffect('deesser'), { thresholdDb: -28 }),
    withParams(createBusEffect('gate'), { thresholdDb: -45 }),
    withParams(createBusEffect('compressor'), { thresholdDb: -24, ratio: 3 }),
    withParams(createBusEffect('limiter'), { ceilingDb: -3 }),
  ];
  const musicFx: BusEffect[] = [
    {
      ...createBusEffect('eq'),
      kind: 'eq',
      bands: [
        { type: 'lowShelf', frequency: 120, gainDb: 3, q: 0.7071, enabled: true },
        { type: 'peaking', frequency: 900, gainDb: -4, q: 1.2, enabled: true },
        { type: 'lowPass', frequency: 15000, gainDb: 0, q: 0.7071, enabled: true },
      ],
    } as BusEffect,
  ];
  return {
    tracks: [
      track('dialogue', 'video', { audioFx: dialogueFx }),
      track('music', 'audio', {
        audioFx: musicFx,
        duck: { sourceTrackId: 'dialogue', depthDb: 9, thresholdDb: -38, attack: 0.04, hold: 0.15, release: 0.4 },
      }),
      track('fx', 'audio'),
      track('titles', 'text'),
    ],
    masterBus: {
      fx: [
        withParams(createBusEffect('compressor'), { thresholdDb: -18, ratio: 2, makeupDb: 2 }),
        withParams(createBusEffect('limiter'), { ceilingDb: -2 }),
      ],
    },
  };
}

/** The export premix of `lanes` (each a whole clip on its lane) through `plan`. */
async function exportMix(plan: BusGraphPlan, lanes: Float32Array[][], frames: number): Promise<Float32Array[]> {
  const entries: MediaEngineMixEntry[] = plan.laneTrackIds
    .filter((_, i) => lanes[i])
    .map((trackId) => ({
      clipId: trackId,
      timelineStart: 0,
      duration: frames / RATE,
      bufferOffset: 0,
      volume: 1,
      audioFadeIn: 0,
      audioFadeOut: 0,
      bus: plan.laneIndex.get(trackId)!,
    }));
  const pcm: Record<string, ClipPcm> = {};
  plan.laneTrackIds.forEach((trackId, i) => {
    if (lanes[i]) pcm[trackId] = { sampleRate: RATE, channelData: lanes[i]! };
  });
  const stream = await openTimelineMixStream(entries, pcm, {
    baseUrl: WASM_BASE,
    sampleRate: RATE,
    durationSec: frames / RATE,
    chunkFrames: 48000,
    bus: plan,
  });
  expect(stream).not.toBeNull();
  const out = [new Float32Array(frames), new Float32Array(frames)];
  try {
    for await (const chunk of stream!) {
      for (let i = 0; i < chunk.frameCount; i++) {
        out[0]![chunk.startFrame + i] = chunk.frames[i * 2]!;
        out[1]![chunk.startFrame + i] = chunk.frames[i * 2 + 1]!;
      }
    }
  } finally {
    stream!.close();
  }
  return out;
}

describe('lane buses: AudioWorklet preview vs export premix', () => {
  it('a 10 s chain with every bus effect nulls below -90 dBFS', async () => {
    expect(await loadMediaEngineModule({ baseUrl: WASM_BASE })).not.toBeNull();
    const { tracks, masterBus } = fullChainProject();
    const plan = planBusGraph(tracks, masterBus);
    expect(plan.laneTrackIds).toEqual(['dialogue', 'music', 'fx']);
    expect(plan.ducks).toEqual([{ trackId: 'music', keyTrackId: 'dialogue' }]);
    const seconds = 10;
    const frames = seconds * RATE;
    const lanes = [laneSignal(seconds, 0.6, 1, true), laneSignal(seconds, 0.7, 2), laneSignal(seconds, 0.2, 3)];

    const exported = await exportMix(plan, lanes, frames);
    const { proc, latency } = await startProcessor(plan);
    expect(latency).toBeGreaterThan(0);
    // The worklet cannot look ahead in real time: its output lags by the
    // graph's latency, which the preview's playhead accounts for.
    const padded = lanes.map((lane) => lane.map((plane) => {
      const p = new Float32Array(frames + latency);
      p.set(plane);
      return p;
    }));
    const previewed = runProcessor(proc, padded, frames + latency);

    let worst = 0;
    let energy = 0;
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < frames; i++) {
        worst = Math.max(worst, Math.abs(exported[c]![i]! - previewed[c]![i + latency]!));
        energy += exported[c]![i]! ** 2;
      }
    }
    expect(energy).toBeGreaterThan(1000); // the mix is not silence
    expect(20 * Math.log10(Math.max(worst, 1e-30))).toBeLessThan(-90);
    // ...and the FX really ran: the processed mix is far from the dry lane sum.
    let fromDry = 0;
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < frames; i++) {
        const dry = lanes[0]![c]![i]! + lanes[1]![c]![i]! + lanes[2]![c]![i]!;
        fromDry = Math.max(fromDry, Math.abs(exported[c]![i]! - dry));
      }
    }
    expect(fromDry).toBeGreaterThan(0.1);
  }, 60_000);

  it('passes the lanes through dry until the module is ready, then reports meters', async () => {
    const plan = planBusGraph([track('a', 'video'), track('b', 'audio')], {
      fx: [withParams(createBusEffect('compressor'), { thresholdDb: -30 })],
    });
    const proc = new Processor({
      numberOfInputs: 3,
      processorOptions: { module: fxModule, layout: busLayoutMessage(plan, true) },
    });
    const a = new Float32Array(QUANTUM).fill(0.25);
    const b = new Float32Array(QUANTUM).fill(0.125);
    const outputs = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];
    proc.process([[a, a], [b], []], outputs);
    // Before instantiation finishes: the dry sum (a mono input feeds both channels).
    expect(outputs[0]![0]![0]).toBeCloseTo(0.375, 6);
    expect(outputs[0]![1]![0]).toBeCloseTo(0.375, 6);

    const { proc: ready } = await startProcessor(plan, true);
    const lanes = [laneSignal(1, 0.5, 4), laneSignal(1, 0.5, 5)];
    runProcessor(ready, lanes, RATE);
    const meters = ready.port.posted.filter((m) => (m as { type?: string }).type === 'meters') as Array<{
      values: Float64Array;
    }>;
    // About ten readouts per second, each the MIX_METER layout plus one value per lane.
    expect(meters.length).toBeGreaterThanOrEqual(9);
    expect(meters.at(-1)!.values).toHaveLength(7 + 2);
    expect(meters.at(-1)!.values[0]).toBeGreaterThan(-40);
  }, 30_000);

  it('retunes in place on a parameter edit and rebuilds on a structure change', async () => {
    const { tracks, masterBus } = fullChainProject();
    const plan = planBusGraph(tracks, masterBus);
    const { proc } = await startProcessor(plan);
    const readyCount = () => proc.port.posted.filter((m) => (m as { type?: string }).type === 'ready').length;
    expect(readyCount()).toBe(1);

    const retuned = fullChainProject();
    (retuned.masterBus.fx![0] as { thresholdDb: number }).thresholdDb = -12;
    proc.port.onmessage!({ data: { type: 'layout', layout: busLayoutMessage(planBusGraph(retuned.tracks, retuned.masterBus), false) } });
    expect(readyCount()).toBe(1); // same graph, new coefficients

    const grown = fullChainProject();
    grown.masterBus.fx!.push(createBusEffect('gate'));
    proc.port.onmessage!({ data: { type: 'layout', layout: busLayoutMessage(planBusGraph(grown.tracks, grown.masterBus), false) } });
    expect(readyCount()).toBe(2); // new stage: a new graph
  }, 30_000);
});
