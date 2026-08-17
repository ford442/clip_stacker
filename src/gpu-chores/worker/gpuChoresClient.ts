import type { GpuChoreJob, GpuChoreResult } from '../types';
import type { ChoresWorkerRequest, ChoresWorkerResponse } from './gpuChores.worker';

type Pending = {
  resolve: (result: GpuChoreResult) => void;
  reject: (err: Error) => void;
};

let worker: Worker | null = null;
let failed = false;
let nextId = 1;
const pending = new Map<number, Pending>();

export function isChoresWorkerAvailable(): boolean {
  if (failed) return false;
  try {
    if (import.meta.env?.VITEST) return false;
  } catch {
    /* not bundled */
  }
  if (worker) return true;
  return typeof Worker !== 'undefined';
}

function ensureWorker(): Worker | null {
  if (failed) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined') {
    failed = true;
    return null;
  }
  try {
    worker = new Worker(new URL('./gpuChores.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<ChoresWorkerResponse>) => {
      const msg = ev.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    };
    worker.onerror = () => {
      failed = true;
      for (const [, p] of pending) p.reject(new Error('gpu-chores worker error'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    failed = true;
    worker = null;
    return null;
  }
}

export async function runWorkerJob(job: GpuChoreJob, reason: string): Promise<GpuChoreResult> {
  const w = ensureWorker();
  if (!w) throw new Error('gpu-chores worker unavailable');
  const id = nextId++;
  const payload: GpuChoreJob = {
    ...job,
    source: undefined,
    pixels: job.pixels ? new Uint8ClampedArray(job.pixels) : undefined,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => resolve({ ...result, backend: 'wasm', reason }),
      reject,
    });
    const req: ChoresWorkerRequest = { id, job: payload };
    const transfer: Transferable[] = [];
    if (payload.pixels) transfer.push(payload.pixels.buffer);
    w.postMessage(req, transfer);
  });
}

export function __resetChoresWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  failed = false;
  pending.clear();
}
