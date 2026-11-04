/**
 * Failure paths of the lane-bus worklet (`public/worklets/audio-fx-processor.js`):
 * whatever goes wrong inside the module, the preview falls back to the dry
 * lane sum and reports an `error` (the main thread then shows "FX not
 * previewed"). It must never throw out of `process` — that raises
 * `processorerror` and the node goes silent for good.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { createBusEffect } from '../utils/audioBus';
import { planBusGraph } from '../audio/fxGraph';
import { busLayoutMessage } from './audioFx';
import {
  WORKLET_QUANTUM as QUANTUM,
  loadFxModule,
  loadProcessorClass,
  waitForReady,
  type Processor,
  type ProcessorClass,
} from './audioFxWorklet.test.helpers';

let fxModule: WebAssembly.Module;
let ProcessorCtor: ProcessorClass;

beforeAll(async () => {
  fxModule = await loadFxModule();
  ProcessorCtor = loadProcessorClass();
});

interface ProcessorInternals {
  exports: Record<string, unknown>;
  failed: boolean;
  onMessage(message: unknown): void;
}

function plan() {
  const tracks: Track[] = [
    {
      id: 'dialogue',
      kind: 'video',
      items: [],
      audioFx: [{ ...createBusEffect('compressor'), thresholdDb: -30, ratio: 8 } as never],
    },
    { id: 'music', kind: 'audio', items: [] },
  ];
  return planBusGraph(tracks, undefined);
}

async function startProcessor(): Promise<{ proc: Processor; internals: ProcessorInternals }> {
  const p = plan();
  const proc = new ProcessorCtor({
    numberOfInputs: p.laneTrackIds.length + 1,
    processorOptions: { module: fxModule, layout: busLayoutMessage(p, false) },
  });
  await waitForReady(proc);
  return { proc, internals: proc as unknown as ProcessorInternals };
}

/** One quantum: a loud tone on lane 0, a quiet one on lane 1, nothing direct. */
function quantum(): { inputs: Float32Array[][]; dry: Float32Array } {
  const a = new Float32Array(QUANTUM);
  const b = new Float32Array(QUANTUM);
  for (let i = 0; i < QUANTUM; i++) {
    a[i] = 0.9 * Math.sin(i / 5);
    b[i] = 0.1 * Math.cos(i / 7);
  }
  const dry = new Float32Array(QUANTUM);
  for (let i = 0; i < QUANTUM; i++) dry[i] = a[i]! + b[i]!;
  return { inputs: [[a, a], [b, b], []], dry };
}

function run(proc: Processor, inputs: Float32Array[][]): Float32Array[] {
  const outputs = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];
  expect(proc.process(inputs, outputs)).toBe(true);
  return outputs[0]!;
}

function errors(proc: Processor): string[] {
  return proc.port.posted
    .filter((m) => (m as { type?: string }).type === 'error')
    .map((m) => (m as { message: string }).message);
}

describe('bus FX worklet failure paths', () => {
  it('processes wet while healthy', async () => {
    const { proc } = await startProcessor();
    const { inputs } = quantum();
    run(proc, inputs);
    expect(errors(proc)).toEqual([]);
  });

  it('a trap in bus_graph_process gives the dry sum and an error, not silence', async () => {
    const { proc, internals } = await startProcessor();
    internals.exports = {
      ...internals.exports,
      bus_graph_process: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      },
    };
    const { inputs, dry } = quantum();
    let out: Float32Array[] = [];
    expect(() => {
      out = run(proc, inputs);
    }).not.toThrow();
    expect(Array.from(out[0]!)).toEqual(Array.from(dry));
    expect(Array.from(out[1]!)).toEqual(Array.from(dry));
    expect(errors(proc)).toHaveLength(1);
    expect(errors(proc)[0]).toMatch(/process: unreachable/);

    // Later quanta stay dry; the retired instance is never called again.
    let calls = 0;
    internals.exports = { ...internals.exports, bus_graph_reset: () => calls++ };
    internals.onMessage({ type: 'reset' });
    expect(calls).toBe(0);
    expect(Array.from(run(proc, inputs)[0]!)).toEqual(Array.from(dry));
    expect(errors(proc)).toHaveLength(1);
  });

  it('a non-OK status from bus_graph_process falls back to dry', async () => {
    const { proc, internals } = await startProcessor();
    internals.exports = { ...internals.exports, bus_graph_process: () => -1 };
    const { inputs, dry } = quantum();
    expect(Array.from(run(proc, inputs)[0]!)).toEqual(Array.from(dry));
    expect(errors(proc)[0]).toMatch(/status -1/);
  });

  it('an EINVAL / ERANGE from bus_graph_update is reported, not ignored', async () => {
    for (const status of [-1, -4]) {
      const { proc, internals } = await startProcessor();
      internals.exports = { ...internals.exports, bus_graph_update: () => status };
      internals.onMessage({ type: 'layout', layout: busLayoutMessage(plan(), false) });
      expect(internals.failed).toBe(true);
      expect(errors(proc)[0]).toMatch(new RegExp(`status ${status}`));
      const { inputs, dry } = quantum();
      expect(Array.from(run(proc, inputs)[0]!)).toEqual(Array.from(dry));
    }
  });

  it('refuses a layout whose lane count does not match the node inputs', async () => {
    const { proc, internals } = await startProcessor();
    const p = plan();
    const layout = busLayoutMessage(p, false);
    const extra = { ...layout, buses: Int32Array.from([...layout.buses, 0, 0]) };
    internals.onMessage({ type: 'layout', layout: extra });
    expect(internals.failed).toBe(true);
    expect(errors(proc)[0]).toMatch(/3 lane buses, node has 2/);
  });
});
