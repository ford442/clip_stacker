import { rasterizeBitmapToRgba } from '../rasterize';
import { runCpuJob } from '../cpu/runCpuJob';
import type { GpuChoreJob, GpuChoreJobSpec, GpuChoreResult } from '../types';

export type ChoresWorkerRequest =
  | { id: number; job: GpuChoreJob }
  | {
      id: number;
      analyzeStill: true;
      specs: GpuChoreJobSpec[];
      bitmap: ImageBitmap;
    };

export type ChoresWorkerResponse =
  | { id: number; ok: true; result: GpuChoreResult }
  | { id: number; ok: true; results: GpuChoreResult[] }
  | { id: number; ok: false; message: string };

function postResponse(msg: ChoresWorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

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

self.onmessage = (ev: MessageEvent<ChoresWorkerRequest>) => {
  const data = ev.data;
  const { id } = data;
  try {
    if ('analyzeStill' in data && data.analyzeStill) {
      const { pixels, width, height } = rasterizeBitmapToRgba(data.bitmap);
      try {
        data.bitmap.close();
      } catch {
        /* detached */
      }
      const results = runSpecsOnPixels(data.specs, pixels, width, height);
      postResponse({ id, ok: true, results }, resultTransferList(results));
      return;
    }

    if (!('job' in data)) {
      throw new Error('gpu-chores worker: missing job');
    }
    const job = data.job;
    const cpu = runCpuJob(job, 'chores worker (TS golden)');
    const result: GpuChoreResult = { ...cpu, backend: 'wasm', reason: cpu.reason };
    postResponse({ id, ok: true, result }, resultTransferList([result]));
  } catch (err) {
    postResponse({
      id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
