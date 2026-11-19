/**
 * Main-thread side of the time-stretch worker. `remapPlanarOffThread` posts
 * the planar source (transferred), the worker runs the chunked WASM session
 * and transfers the output back, so a long clip's stretch never blocks the
 * UI. Without Worker support, or after the worker fails to start, it runs
 * the same code in this realm. Null = use the JS fallback.
 */

import { getWasmPublicBaseUrl } from '../wasm/emscriptenLoader';
import { isMediaEngineMixEnabled } from '../wasm/mediaEngine';
import { wasmRemapPlanar } from '../wasm/timeStretch';
import { createTimeStretchWorker } from '../workers/workerFactories';
import { WorkerCrashedError, createWorkerClient, type WorkerClient, type WorkerLike } from '../workers/workerRpc';
import type { TimeStretchProtocol } from './timeStretch.worker';

export interface RemapPlanarJob {
  input: Float32Array;
  inFrames: number;
  channels: number;
  offsets: Float64Array;
  outFrames: number;
  hop: number;
}

export interface RemapPlanarResult {
  output: Float32Array | null;
  /** The job's input (it travelled to the worker and back). */
  input: Float32Array;
}

type WorkerFactory = () => WorkerLike;

const defaultFactory = (): WorkerFactory | null => (typeof Worker === 'undefined' ? null : createTimeStretchWorker);

let factory: WorkerFactory | null = defaultFactory();
let client: WorkerClient<TimeStretchProtocol> | null = null;

/** The running client, or null: stretch in this realm. */
function workerClient(): WorkerClient<TimeStretchProtocol> | null {
  if (!factory) return null;
  if (!client) {
    client = createWorkerClient<TimeStretchProtocol>(factory, {
      name: 'time-stretch',
      onCrash: (err) => console.warn(`[timeStretch] ${err.message}; stretching on this thread`),
    });
    if (!client.start()) {
      console.warn('[timeStretch] cannot start the worker; stretching on this thread', client.failure);
    }
  }
  return client.available ? client : null;
}

/** Run one remap in the worker (or in this realm without one). */
export async function remapPlanarOffThread(job: RemapPlanarJob): Promise<RemapPlanarResult> {
  if (!isMediaEngineMixEnabled()) return { output: null, input: job.input };
  const c = workerClient();
  if (!c) {
    const output = await wasmRemapPlanar(job.input, job.inFrames, job.channels, job.offsets, job.outFrames, {
      hop: job.hop,
    });
    return { output, input: job.input };
  }
  try {
    const res = await c.call('remap', { ...job, baseUrl: getWasmPublicBaseUrl() }, { transfer: [job.input.buffer] });
    if (res.error) console.warn('[timeStretch] worker remap failed:', res.error);
    return { output: res.output, input: res.input };
  } catch (err) {
    // The input went with the worker: this job falls back to JS (null) and
    // its caller rebuilds the source.
    if (err instanceof WorkerCrashedError) return { output: null, input: new Float32Array(0) };
    // It never left (the post failed): give up on the worker, keep the input.
    console.warn('[timeStretch] worker failed; stretching on this thread', err);
    c.terminate();
    return { output: null, input: job.input };
  }
}

/** Test-only: swap the worker factory (null = no Worker support) and forget the worker. */
export function __setTimeStretchWorkerFactoryForTests(next: WorkerFactory | null | undefined): void {
  client?.terminate();
  client = null;
  factory = next === undefined ? defaultFactory() : next;
}
