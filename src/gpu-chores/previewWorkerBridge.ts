import type { GpuChoreJobSpec, GpuChoreResult } from './types';

/**
 * Main-thread hook into the OffscreenCanvas preview worker, which owns the
 * adopted `GPUDevice`. Chores never call `requestDevice()`.
 */
export interface PreviewWorkerChoresRunner {
  runJobs(jobs: GpuChoreJobSpec[], source: ImageBitmap): Promise<GpuChoreResult[]>;
}

let runner: PreviewWorkerChoresRunner | null = null;

export function setPreviewWorkerChoresRunner(next: PreviewWorkerChoresRunner | null): void {
  runner = next;
}

export function clearPreviewWorkerChoresRunner(expected: PreviewWorkerChoresRunner): void {
  if (runner === expected) runner = null;
}

export function isPreviewWorkerChoresAvailable(): boolean {
  return runner !== null;
}

export async function runPreviewWorkerJobs(
  jobs: GpuChoreJobSpec[],
  source: ImageBitmap,
): Promise<GpuChoreResult[]> {
  if (!runner) throw new Error('preview worker chores unavailable');
  return runner.runJobs(jobs, source);
}

export function __resetPreviewWorkerChoresForTests(): void {
  runner = null;
}
