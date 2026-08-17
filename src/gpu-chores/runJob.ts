import { pixelCount, selectBackend } from './breakEven';
import { runCpuJob } from './cpu/runCpuJob';
import { peekChoresGpuDevice } from './device';
import {
  gpuComputeAvailable,
  recordGpuChoreBreadcrumb,
} from './diagnostics';
import {
  isPreviewWorkerChoresAvailable,
  runPreviewWorkerJobs,
} from './previewWorkerBridge';
import { isImageBitmapSource, rasterizeBitmapToRgba } from './rasterize';
import type { GpuChoreJob, GpuChoreJobSpec, GpuChoreResult } from './types';
import { runWebGpuJob } from './webgpu/runWebGpu';
import { isChoresWorkerAvailable, runWorkerJob } from './worker/gpuChoresClient';

/**
 * Run a gpu-chores kernel. Backend order for `prefer: 'auto'`:
 * 1. Adopted WebGPU device on this thread (never `requestDevice` from here)
 * 2. Preview-worker GPU (same physical device, OffscreenCanvas realm)
 * 3. Off-thread chores Worker (TS golden)
 * 4. Main-thread TypeScript
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
    } else if (isPreviewWorkerChoresAvailable() && isImageBitmapSource(job.source)) {
      try {
        result = await runViaPreviewWorker(job, selection.reason);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        result = await runFallback(
          job,
          `${selection.reason}; preview worker GPU failed (${why})`,
          workerAvailable,
        );
      }
    } else {
      result = await runFallback(job, `${selection.reason}; device vanished`, workerAvailable);
    }
  } else if (selection.backend === 'wasm') {
    result = await runFallback(job, selection.reason, true);
  } else {
    result = await runFallback(job, selection.reason, false);
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

function toSpec(job: GpuChoreJob): GpuChoreJobSpec {
  return {
    op: job.op,
    prefer: job.prefer,
    width: job.width,
    height: job.height,
    outWidth: job.outWidth,
    outHeight: job.outHeight,
    radius: job.radius,
  };
}

async function runViaPreviewWorker(job: GpuChoreJob, reason: string): Promise<GpuChoreResult> {
  const source = job.source;
  if (!isImageBitmapSource(source)) {
    throw new Error('preview worker GPU requires ImageBitmap source');
  }
  const copy = typeof createImageBitmap === 'function' ? await createImageBitmap(source) : source;
  const [result] = await runPreviewWorkerJobs([toSpec(job)], copy);
  if (!result) throw new Error('preview worker returned no chore result');
  return { ...result, reason: `${reason}; ${result.reason}` };
}

async function withPixels(job: GpuChoreJob): Promise<GpuChoreJob> {
  if (job.pixels && job.pixels.length >= job.width * job.height * 4) return job;
  if (!job.source) return job;
  const raster = rasterizeBitmapToRgba(job.source);
  return { ...job, pixels: raster.pixels, width: raster.width, height: raster.height };
}

async function runFallback(
  job: GpuChoreJob,
  reason: string,
  tryWorker: boolean,
): Promise<GpuChoreResult> {
  const cpuJob = await withPixels(job);
  if (tryWorker && cpuJob.pixels) {
    try {
      return await runWorkerJob(cpuJob, reason);
    } catch {
      /* main-thread CPU */
    }
  }
  return runCpuJob(cpuJob, `${reason}; CPU`);
}
