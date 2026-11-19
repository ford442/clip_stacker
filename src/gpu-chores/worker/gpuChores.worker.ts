/**
 * The chores worker: CPU-golden kernels off the main thread, served through
 * the worker RPC (`src/workers/workerRpc.ts`).
 */

import { rasterizeBitmapToRgba } from '../rasterize';
import { runCpuJob } from '../cpu/runCpuJob';
import type { GpuChoreJob, GpuChoreJobSpec, GpuChoreResult } from '../types';
import { exposeWorker, withTransfer } from '../../workers/workerRpc';

export type GpuChoresProtocol = {
  /** One CPU-golden job on the given pixels (transferred). */
  job: { req: GpuChoreJob; res: GpuChoreResult };
  /** Rasterize `bitmap` (transferred), then run every spec on its pixels. */
  analyzeStill: { req: { specs: GpuChoreJobSpec[]; bitmap: ImageBitmap }; res: GpuChoreResult[] };
};

function resultTransferList(results: GpuChoreResult[]): Transferable[] {
  const transfer: Transferable[] = [];
  for (const result of results) {
    if (result.histogram) transfer.push(result.histogram.buffer);
    if (result.pixels) transfer.push(result.pixels.buffer);
  }
  return transfer;
}

function runSpecsOnPixels(
  specs: GpuChoreJobSpec[],
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): GpuChoreResult[] {
  return specs.map((spec) => {
    const cpu = runCpuJob(
      { ...spec, pixels, width: spec.width ?? width, height: spec.height ?? height },
      'chores worker (TS golden)',
    );
    return { ...cpu, backend: 'wasm', reason: cpu.reason };
  });
}

exposeWorker<GpuChoresProtocol>({
  job: (job) => {
    const cpu = runCpuJob(job, 'chores worker (TS golden)');
    const result: GpuChoreResult = { ...cpu, backend: 'wasm', reason: cpu.reason };
    return withTransfer(result, resultTransferList([result]));
  },
  analyzeStill: ({ specs, bitmap }) => {
    const { pixels, width, height } = rasterizeBitmapToRgba(bitmap);
    try {
      bitmap.close();
    } catch {
      /* detached */
    }
    const results = runSpecsOnPixels(specs, pixels, width, height);
    return withTransfer(results, resultTransferList(results));
  },
});
