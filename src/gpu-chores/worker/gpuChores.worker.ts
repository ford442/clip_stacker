import { runCpuJob } from '../cpu/runCpuJob';
import type { GpuChoreJob, GpuChoreResult } from '../types';

export type ChoresWorkerRequest = {
  id: number;
  job: GpuChoreJob;
};

export type ChoresWorkerResponse =
  | { id: number; ok: true; result: GpuChoreResult }
  | { id: number; ok: false; message: string };

self.onmessage = (ev: MessageEvent<ChoresWorkerRequest>) => {
  const { id, job } = ev.data;
  try {
    const cpu = runCpuJob(job, 'chores worker (TS golden)');
    const result: GpuChoreResult = { ...cpu, backend: 'wasm', reason: cpu.reason };
    const transfer: Transferable[] = [];
    if (result.histogram) transfer.push(result.histogram.buffer);
    if (result.pixels) transfer.push(result.pixels.buffer);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, result } satisfies ChoresWorkerResponse, transfer);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    } satisfies ChoresWorkerResponse);
  }
};
