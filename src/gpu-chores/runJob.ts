import { pixelCount, selectBackend } from './breakEven';
import { runCpuJob } from './cpu/runCpuJob';
import { peekChoresGpuDevice } from './device';
import {
  gpuComputeAvailable,
  recordGpuChoreBreadcrumb,
} from './diagnostics';
import type { GpuChoreJob, GpuChoreResult } from './types';
import { runWebGpuJob } from './webgpu/runWebGpu';
import { isChoresWorkerAvailable, runWorkerJob } from './worker/gpuChoresClient';

/**
 * Run a gpu-chores kernel. Backend order for `prefer: 'auto'`:
 * 1. Adopted WebGPU device (never `requestDevice` from here)
 * 2. Off-thread Worker (TS golden; same math as CPU)
 * 3. Main-thread TypeScript
 *
 * WebGL2 is intentionally not used (one GPU API per working set).
 */
export async function runJob(job: GpuChoreJob): Promise<GpuChoreResult> {
  const prefer = job.prefer ?? 'auto';
  const gpu = gpuComputeAvailable();
  const workerAvailable = isChoresWorkerAvailable();
  const selection = selectBackend({
    op: job.op,
    prefer,
    width: job.width,
    height: job.height,
    outWidth: job.outWidth,
    outHeight: job.outHeight,
    radius: job.radius,
    gpuAvailable: gpu.available,
    workerAvailable,
  });

  let result: GpuChoreResult;
  if (selection.backend === 'webgpu') {
    const device = peekChoresGpuDevice();
    if (device) {
      try {
        result = await runWebGpuJob(device, job, selection.reason);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        result = await runFallback(job, `${selection.reason}; WebGPU failed (${why})`, workerAvailable);
      }
    } else {
      result = await runFallback(job, `${selection.reason}; device vanished`, workerAvailable);
    }
  } else if (selection.backend === 'wasm') {
    result = await runFallback(job, selection.reason, true);
  } else {
    result = runCpuJob(job, selection.reason);
  }

  recordGpuChoreBreadcrumb({
    op: job.op,
    backend: result.backend,
    reason: result.reason,
    width: job.width,
    height: job.height,
    pixelCount: pixelCount(job.width, job.height),
    at: Date.now(),
  });
  return result;
}

async function runFallback(
  job: GpuChoreJob,
  reason: string,
  tryWorker: boolean,
): Promise<GpuChoreResult> {
  if (tryWorker && job.pixels) {
    try {
      return await runWorkerJob(job, reason);
    } catch {
      /* main-thread CPU */
    }
  }
  return runCpuJob(job, `${reason}; CPU`);
}
