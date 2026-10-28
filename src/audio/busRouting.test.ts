import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';
import { createBusEffect } from '../utils/audioBus';
import { planBusGraph } from './fxGraph';
import { audioFxStore } from '../store/audioFxStore';

const fx = vi.hoisted(() => ({
  enabled: true,
  fail: null as string | null,
  nodes: [] as Array<{
    lanes: number;
    layouts: unknown[];
    callbacks: { onReady?(latency: number): void; onError?(reason: string): void };
    connections: Array<{ to: unknown }>;
    resets: number;
    disposed: boolean;
  }>,
}));

vi.mock('../wasm/audioFx', () => ({
  isAudioFxPreviewEnabled: () => fx.enabled,
  audioWorkletSupported: () => true,
  createBusFxNode: async (
    _ctx: unknown,
    plan: { laneTrackIds: string[] },
    _meter: boolean,
    callbacks: (typeof fx.nodes)[number]['callbacks'],
  ) => {
    if (fx.fail) throw new Error(fx.fail);
    const record = {
      lanes: plan.laneTrackIds.length,
      layouts: [] as unknown[],
      callbacks,
      connections: [] as Array<{ to: unknown }>,
      resets: 0,
      disposed: false,
    };
    fx.nodes.push(record);
    const node = { connect: (to: unknown) => record.connections.push({ to }), disconnect: () => {} };
    return {
      node,
      lanes: record.lanes,
      input: (i: number) => Math.min(record.lanes, i),
      setLayout: (plan2: unknown) => record.layouts.push(plan2),
      reset: () => {
        record.resets += 1;
      },
      resetMeter: () => {},
      dispose: () => {
        record.disposed = true;
      },
    };
  },
}));

// Imported after the mock is registered.
const { PreviewBusRouting } = await import('./busRouting');

interface FakeGain {
  inputs: Array<{ node: unknown; index: number }>;
  connect(node: unknown, output?: number, index?: number): void;
  disconnect(): void;
}

function fakeContext() {
  return {
    sampleRate: 48000,
    createGain(): FakeGain {
      const gain: FakeGain = {
        inputs: [],
        connect(node, _output, index = 0) {
          gain.inputs.push({ node, index });
        },
        disconnect() {},
      };
      return gain;
    },
  } as unknown as AudioContext;
}

const master = { id: 'master' } as unknown as AudioNode;

function tracks(withFx: boolean): Track[] {
  return [
    { id: 'v1', kind: 'video', items: [], ...(withFx ? { audioFx: [createBusEffect('compressor')] } : {}) },
    { id: 'a1', kind: 'audio', items: [] },
  ];
}

describe('PreviewBusRouting', () => {
  beforeEach(() => {
    fx.enabled = true;
    fx.fail = null;
    fx.nodes.length = 0;
    audioFxStore.setState({ preview: { state: 'idle' }, meters: null, meterLaneTrackIds: [], meterRequests: 0 });
  });

  it('leaves the dry graph alone when nothing needs processing', async () => {
    const routing = new PreviewBusRouting();
    const changed = await routing.sync(fakeContext(), master, planBusGraph(tracks(false), undefined), false, () => {});
    expect(changed).toBe(false);
    expect(fx.nodes).toHaveLength(0);
    expect(routing.destination('v1', master)).toBe(master);
    expect(audioFxStore.getState().preview.state).toBe('idle');
  });

  it('wires one input per lane plus the direct input, and routes entries by lane', async () => {
    const routing = new PreviewBusRouting();
    const ctx = fakeContext();
    const changed = await routing.sync(ctx, master, planBusGraph(tracks(true), undefined), false, () => {});
    expect(changed).toBe(true);
    expect(fx.nodes).toHaveLength(1);
    expect(fx.nodes[0]!.connections).toEqual([{ to: master }]);
    const v1 = routing.destination('v1', master) as unknown as FakeGain;
    const a1 = routing.destination('a1', master) as unknown as FakeGain;
    const direct = routing.destination(undefined, master) as unknown as FakeGain;
    expect(v1.inputs[0]!.index).toBe(0);
    expect(a1.inputs[0]!.index).toBe(1);
    expect(direct.inputs[0]!.index).toBe(2);
    expect(routing.destination('unknown-lane', master)).toBe(direct);
    expect(audioFxStore.getState().preview.state).toBe('loading');
    fx.nodes[0]!.callbacks.onReady!(480);
    expect(audioFxStore.getState().preview).toEqual({ state: 'active', latencyFrames: 480 });
    expect(routing.latencySec).toBeCloseTo(0.01);
  });

  it('retunes the running node for a parameter edit, rebuilds it for a lane change', async () => {
    const routing = new PreviewBusRouting();
    const ctx = fakeContext();
    await routing.sync(ctx, master, planBusGraph(tracks(true), undefined), false, () => {});
    const edited = tracks(true);
    edited[1] = { ...edited[1]!, audioFx: [createBusEffect('gate')] };
    expect(await routing.sync(ctx, master, planBusGraph(edited, undefined), false, () => {})).toBe(false);
    expect(fx.nodes).toHaveLength(1);
    expect(fx.nodes[0]!.layouts).toHaveLength(1);

    const grown = [...edited, { id: 'a2', kind: 'audio' as const, items: [] }];
    expect(await routing.sync(ctx, master, planBusGraph(grown, undefined), false, () => {})).toBe(true);
    expect(fx.nodes).toHaveLength(2);
    expect(fx.nodes[0]!.disposed).toBe(true);
  });

  it('a loudness meter alone keeps the graph running over dry lanes', async () => {
    const routing = new PreviewBusRouting();
    await routing.sync(fakeContext(), master, planBusGraph(tracks(false), undefined), true, () => {});
    expect(fx.nodes).toHaveLength(1);
  });

  it('?no_audio_fx and load failures fall back to the dry graph and say why', async () => {
    const routing = new PreviewBusRouting();
    fx.enabled = false;
    await routing.sync(fakeContext(), master, planBusGraph(tracks(true), undefined), false, () => {});
    expect(audioFxStore.getState().preview.state).toBe('disabled');
    expect(routing.destination('v1', master)).toBe(master);

    fx.enabled = true;
    fx.fail = 'HTTP 404 for media_engine_fx.wasm';
    await routing.sync(fakeContext(), master, planBusGraph(tracks(true), undefined), false, () => {});
    expect(audioFxStore.getState().preview).toEqual({ state: 'failed', reason: 'HTTP 404 for media_engine_fx.wasm' });
    expect(routing.destination('v1', master)).toBe(master);
  });

  it('a graph that fails while running tears down and asks for a reschedule', async () => {
    const routing = new PreviewBusRouting();
    const lost = vi.fn();
    await routing.sync(fakeContext(), master, planBusGraph(tracks(true), undefined), false, lost);
    fx.nodes[0]!.callbacks.onError!('processor error');
    expect(lost).toHaveBeenCalledOnce();
    expect(routing.active).toBe(false);
    expect(routing.destination('v1', master)).toBe(master);
    expect(audioFxStore.getState().preview).toEqual({ state: 'failed', reason: 'processor error' });
  });
});
