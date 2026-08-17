import type { GpuChoreJob, GpuChoreJobSpec, GpuChoreResult } from '../types';
import type { ChoresWorkerRequest, ChoresWorkerResponse } from './gpuChores.worker';

type Pending = {
  resolve: (result: GpuChoreResult | GpuChoreResult[]) => void;
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
  // Already inside a worker (preview / chores) — don't nest another Worker.
  if (typeof window === 'undefined') return false;
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
      if (!msg.ok) {
        p.reject(new Error(msg.message));
        return;
      }
      if ('results' in msg && msg.results) p.resolve(msg.results);
      else if ('result' in msg) p.resolve(msg.result);
      else p.reject(new Error('gpu-chores worker returned no result'));
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
      resolve: (result) => {
        const one = Array.isArray(result) ? result[0] : result;
        if (!one) {
          reject(new Error('gpu-chores worker returned empty result'));
          return;
        }
        resolve({ ...one, backend: 'wasm', reason });
      },
      reject,
    });
    const req: ChoresWorkerRequest = { id, job: payload };
    const transfer: Transferable[] = [];
    if (payload.pixels) transfer.push(payload.pixels.buffer);
    w.postMessage(req, transfer);
  });
}

/** Rasterize an ImageBitmap off the main thread, then run CPU-golden specs. Transfers `bitmap`. */
export async function runWorkerAnalyzeStill(
  bitmap: ImageBitmap,
  specs: GpuChoreJobSpec[],
): Promise<GpuChoreResult[]> {
  const w = ensureWorker();
  if (!w) throw new Error('gpu-chores worker unavailable');
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => {
        resolve(Array.isArray(result) ? result : [result]);
      },
      reject,
    });
    const req: ChoresWorkerRequest = { id, analyzeStill: true, specs, bitmap };
    w.postMessage(req, [bitmap]);
  });
}

export function __resetChoresWorkerForTests(): void {
  worker?.terminate();
  worker = null;
  failed = false;
  pending.clear();
}
