/**
 * Structured WebGPU boot probe for Chrome vs Edge diagnosis.
 * Uses the shared acquireGpuContext() path — never a second requestDevice().
 */

import { acquireGpuContext } from './gpuDevice';

export interface WebGpuAdapterSnapshot {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

export interface WebGpuProbeResult {
  ok: boolean;
  browser: string;
  reason: string;
  adapter: WebGpuAdapterSnapshot | null;
}

export type WebGpuProbeRealm = 'main' | 'worker';

export interface WindowWebGpuProbe {
  main?: WebGpuProbeResult;
  worker?: WebGpuProbeResult;
}

let published: WindowWebGpuProbe = {};

export function classifyBrowser(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): string {
  const s = ua.toLowerCase();
  if (s.includes('edg/')) return 'Edge';
  if (s.includes('chrome/')) return 'Chrome';
  return 'other';
}

export function adapterSnapshot(adapter: GPUAdapter): WebGpuAdapterSnapshot | null {
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  if (!info) return null;
  const snap: WebGpuAdapterSnapshot = {};
  if (info.vendor) snap.vendor = info.vendor;
  if (info.architecture) snap.architecture = info.architecture;
  if (info.device) snap.device = info.device;
  if (info.description) snap.description = info.description;
  return Object.keys(snap).length > 0 ? snap : null;
}

export function classifyProbeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/not available in this browser/i.test(message) || /no navigator\.gpu/i.test(message)) {
    return 'no navigator.gpu';
  }
  if (/no webgpu adapter/i.test(message)) {
    return 'requestAdapter returned null';
  }
  return `requestDevice rejected: ${message}`;
}

/**
 * Probe navigator.gpu + adapter + device via acquireGpuContext().
 */
export async function probeWebGpu(): Promise<WebGpuProbeResult> {
  const browser = classifyBrowser();
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return {
      ok: false,
      browser,
      reason: 'no navigator.gpu',
      adapter: null,
    };
  }
  try {
    const ctx = await acquireGpuContext();
    return {
      ok: true,
      browser,
      reason: 'ok',
      adapter: adapterSnapshot(ctx.adapter),
    };
  } catch (err) {
    return {
      ok: false,
      browser,
      reason: classifyProbeError(err),
      adapter: null,
    };
  }
}

export function publishWebGpuProbe(
  realm: WebGpuProbeRealm,
  result: WebGpuProbeResult,
): WindowWebGpuProbe {
  published = { ...published, [realm]: result };
  console.info('[webgpuProbe]', realm, result);
  if (typeof window !== 'undefined') {
    (window as Window & { webgpuProbe?: WindowWebGpuProbe }).webgpuProbe = published;
  }
  return published;
}

export function getPublishedWebGpuProbe(): WindowWebGpuProbe {
  return published;
}

export function sessionWebGpuAvailable(): boolean {
  const worker = published.worker;
  if (worker) return worker.ok;
  return published.main?.ok === true;
}

export function __resetWebGpuProbeForTests(): void {
  published = {};
  if (typeof window !== 'undefined') {
    delete (window as Window & { webgpuProbe?: WindowWebGpuProbe }).webgpuProbe;
  }
}
