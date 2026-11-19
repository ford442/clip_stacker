/**
 * Main-thread side of the chores worker (`gpuChores.worker.ts`, through the
 * worker RPC). A worker that fails to start or dies is not retried: chores
 * fall back to the main-thread TS path.
 */

import type { GpuChoreJob, GpuChoreJobSpec, GpuChoreResult } from '../types';
import type { GpuChoresProtocol } from './gpuChores.worker';
import { createGpuChoresWorker } from '../../workers/workerFactories';
import { createWorkerClient, type WorkerClient } from '../../workers/workerRpc';

let client: WorkerClient<GpuChoresProtocol> | null = null;

export function isChoresWorkerAvailable(): boolean {
  if (client && !client.available) return false;
  try {
    if (import.meta.env?.VITEST) return false;
  } catch {
    /* not bundled */
  }
  // Already inside a worker (preview / chores) — don't nest another Worker.
  if (typeof window === 'undefined') return false;
  if (client) return true;
  return typeof Worker !== 'undefined';
}

function choresClient(): WorkerClient<GpuChoresProtocol> | null {
  if (!client) {
    if (typeof Worker === 'undefined') return null;
    client = createWorkerClient<GpuChoresProtocol>(createGpuChoresWorker, { name: 'gpu-chores' });
  }
  return client.start() ? client : null;
}

export async function runWorkerJob(job: GpuChoreJob, reason: string): Promise<GpuChoreResult> {
  const c = choresClient();
  if (!c) throw new Error('gpu-chores worker unavailable');
  // The bitmap stays here; the pixels are copied, then moved to the worker.
  const { source: _source, pixels, ...rest } = job;
  const copy = pixels ? new Uint8ClampedArray(pixels) : undefined;
  const payload: GpuChoreJob = copy ? { ...rest, pixels: copy } : rest;
  const result = await c.call('job', payload, { transfer: copy ? [copy.buffer] : [] });
  return { ...result, backend: 'wasm', reason };
}

/** Rasterize an ImageBitmap off the main thread, then run CPU-golden specs. Transfers `bitmap`. */
export async function runWorkerAnalyzeStill(
  bitmap: ImageBitmap,
  specs: GpuChoreJobSpec[],
): Promise<GpuChoreResult[]> {
  const c = choresClient();
  if (!c) throw new Error('gpu-chores worker unavailable');
  return c.call('analyzeStill', { specs, bitmap }, { transfer: [bitmap] });
}
