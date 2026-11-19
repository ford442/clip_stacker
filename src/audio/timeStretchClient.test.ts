import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetMediaEngineLoadStateForTests,
  __setMediaEngineKillSwitchForTests,
  loadMediaEngineModule,
} from '../wasm/mediaEngine';
import { TIME_STRETCH_HOP, wasmRemapPlanar } from '../wasm/timeStretch';
import { __setTimeStretchWorkerFactoryForTests, remapPlanarOffThread } from './timeStretchClient';
import { timeStretchHandlers, type TimeStretchProtocol } from './timeStretch.worker';
import { InProcessWorker, flushWorkerMessages } from '../workers/inProcessWorker.test.helpers';
import { exposeWorker } from '../workers/workerRpc';

const WASM_BASE = pathToFileURL(path.resolve(process.cwd(), 'public/wasm') + path.sep).href;

/** The real worker handlers, served in-process (under happy-dom the loader needs the file URL of public/wasm). */
function inProcessWorker(): InProcessWorker {
  const worker = new InProcessWorker();
  exposeWorker<TimeStretchProtocol>(
    { remap: (req, ctx) => timeStretchHandlers.remap({ ...req, baseUrl: WASM_BASE }, ctx) },
    { scope: worker.scope },
  );
  return worker;
}

function job(frames: number) {
  const input = new Float32Array(frames);
  for (let i = 0; i < frames; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000);
  const outFrames = frames * 2;
  const hops = Math.ceil(outFrames / TIME_STRETCH_HOP) + 1;
  const offsets = Float64Array.from({ length: hops }, (_, h) => h * TIME_STRETCH_HOP * 0.5);
  return { input, inFrames: frames, channels: 1, offsets, outFrames, hop: TIME_STRETCH_HOP };
}

describe('time-stretch worker client', () => {
  beforeEach(() => {
    _resetMediaEngineLoadStateForTests();
  });
  afterEach(() => {
    __setTimeStretchWorkerFactoryForTests(undefined);
    __setMediaEngineKillSwitchForTests(null);
    _resetMediaEngineLoadStateForTests();
    vi.restoreAllMocks();
  });

  it('stretches in the worker, transferring the source there and back', async () => {
    const worker = inProcessWorker();
    __setTimeStretchWorkerFactoryForTests(() => worker);
    const j = job(12_000);
    const reference = await wasmRemapPlanar(j.input, j.inFrames, 1, j.offsets, j.outFrames, { baseUrl: WASM_BASE });
    const sent = j.input;
    const result = await remapPlanarOffThread(j);
    expect(worker.sentPayloads('call', 'remap')).toHaveLength(1);
    expect(sent.length).toBe(0); // transferred away
    expect(result.input.length).toBe(12_000); // and back
    expect(result.output).not.toBeNull();
    expect(Array.from(result.output!)).toEqual(Array.from(reference!));
  });

  it('gives up on a crashed worker: the job falls back, later jobs run on this thread', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = inProcessWorker();
    worker.hold = true;
    __setTimeStretchWorkerFactoryForTests(() => worker);
    const pending = remapPlanarOffThread(job(4096));
    await flushWorkerMessages(1);
    worker.crash('boom');
    const first = await pending;
    expect(first.output).toBeNull();
    expect(first.input.length).toBe(0); // lost with the worker: the caller rebuilds it
    expect(worker.terminated).toBe(true);

    // (Under happy-dom the in-realm loader needs the file URL of public/wasm.)
    await loadMediaEngineModule({ baseUrl: WASM_BASE });
    const second = await remapPlanarOffThread(job(4096));
    expect(worker.sentPayloads('call', 'remap')).toHaveLength(1);
    expect(second.output).not.toBeNull();
  });

  it('never starts the worker under ?no_media_engine', async () => {
    const factory = vi.fn(() => inProcessWorker());
    __setTimeStretchWorkerFactoryForTests(factory);
    __setMediaEngineKillSwitchForTests(true);
    const result = await remapPlanarOffThread(job(4096));
    expect(result.output).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
});
