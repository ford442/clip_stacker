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
import type { TimeStretchRequest, TimeStretchResponse } from './timeStretch.worker';

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

/** What the client needs of a Worker (tests substitute an in-process one). */
export interface TimeStretchWorkerLike {
  postMessage(message: TimeStretchRequest, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<TimeStretchResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  terminate(): void;
}

type WorkerFactory = () => TimeStretchWorkerLike;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./timeStretch.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as TimeStretchWorkerLike;

let factory: WorkerFactory | null = typeof Worker === 'undefined' ? null : defaultFactory;
let worker: TimeStretchWorkerLike | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, { resolve: (res: TimeStretchResponse) => void; job: RemapPlanarJob }>();

function failWorker(reason: string): void {
  console.warn(`[timeStretch] worker failed (${reason}); stretching on this thread`);
  workerFailed = true;
  worker?.terminate();
  worker = null;
  // The inputs went with the worker: those jobs fall back to JS (null) and
  // their callers rebuild the source.
  for (const [id, { resolve }] of pending) {
    resolve({ id, output: null, input: new Float32Array(0) });
  }
  pending.clear();
}

function ensureWorker(): TimeStretchWorkerLike | null {
  if (worker) return worker;
  if (workerFailed || !factory) return null;
  try {
    const w = factory();
    w.onmessage = (ev) => {
      const entry = pending.get(ev.data.id);
      if (!entry) return;
      pending.delete(ev.data.id);
      if (ev.data.error) console.warn('[timeStretch] worker remap failed:', ev.data.error);
      entry.resolve(ev.data);
    };
    w.onerror = (ev) => failWorker(ev.message || 'worker error');
    worker = w;
    return w;
  } catch (err) {
    workerFailed = true;
    console.warn('[timeStretch] cannot start the worker; stretching on this thread', err);
    return null;
  }
}

/** Run one remap in the worker (or in this realm without one). */
export async function remapPlanarOffThread(job: RemapPlanarJob): Promise<RemapPlanarResult> {
  if (!isMediaEngineMixEnabled()) return { output: null, input: job.input };
  const w = ensureWorker();
  if (!w) {
    const output = await wasmRemapPlanar(job.input, job.inFrames, job.channels, job.offsets, job.outFrames, {
      hop: job.hop,
    });
    return { output, input: job.input };
  }
  const id = nextId++;
  const res = await new Promise<TimeStretchResponse>((resolve) => {
    pending.set(id, { resolve, job });
    const request: TimeStretchRequest = { id, ...job, baseUrl: getWasmPublicBaseUrl() };
    try {
      w.postMessage(request, [job.input.buffer]);
    } catch (err) {
      pending.delete(id);
      failWorker((err as Error)?.message || String(err));
      resolve({ id, output: null, input: job.input });
    }
  });
  return { output: res.output, input: res.input };
}

/** Test-only: swap the worker factory (null = no Worker support) and forget the worker. */
export function __setTimeStretchWorkerFactoryForTests(next: WorkerFactory | null | undefined): void {
  worker?.terminate();
  worker = null;
  workerFailed = false;
  pending.clear();
  factory = next === undefined ? (typeof Worker === 'undefined' ? null : defaultFactory) : next;
}
