import type { GpuChoreBreadcrumb, GpuComputeAvailability } from './types';
import { peekChoresGpuDevice } from './device';
import { isPreviewWorkerChoresAvailable } from './previewWorkerBridge';

const KILL_PARAM = 'no_gpu_compute';

let testKillOverride: boolean | null = null;
let lastBreadcrumb: GpuChoreBreadcrumb | null = null;

export function isGpuComputeKillSwitchEnabled(
  search: string = typeof location !== 'undefined' ? location.search : '',
): boolean {
  if (testKillOverride !== null) return testKillOverride;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.has(KILL_PARAM);
}

/**
 * Whether WebGPU compute can run chores. Does not call `requestDevice`.
 * True when this thread holds an adopted device *or* the OffscreenCanvas
 * preview worker (which owns that device) is registered.
 */
export function gpuComputeAvailable(): GpuComputeAvailability {
  if (isGpuComputeKillSwitchEnabled()) {
    return { available: false, reason: 'disabled via ?no_gpu_compute' };
  }
  const device = peekChoresGpuDevice();
  if (device) {
    return { available: true, reason: 'adopted preview WebGPU device' };
  }
  if (isPreviewWorkerChoresAvailable()) {
    return { available: true, reason: 'preview worker GPU' };
  }
  return {
    available: false,
    reason: 'no GPUDevice (preview not started or WebGPU probe failed)',
  };
}

export function recordGpuChoreBreadcrumb(entry: GpuChoreBreadcrumb): void {
  lastBreadcrumb = entry;
}

export function getLastGpuChoreBreadcrumb(): GpuChoreBreadcrumb | null {
  return lastBreadcrumb;
}

export function formatGpuChoreDiagnostics(): string {
  const avail = gpuComputeAvailable();
  const last = lastBreadcrumb;
  const lastLine = last
    ? `last ${last.op} → ${last.backend} (${last.reason}) ${last.width}×${last.height}`
    : 'last job: none';
  return `gpuComputeAvailable: ${avail.available ? 'yes' : 'no'} — ${avail.reason}; ${lastLine}`;
}

export function __setGpuComputeKillSwitchForTests(value: boolean | null): void {
  testKillOverride = value;
}

export function __resetGpuChoreDiagnosticsForTests(): void {
  testKillOverride = null;
  lastBreadcrumb = null;
}
