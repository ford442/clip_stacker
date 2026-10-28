import type { WebGpuProbeResult } from '../webgpu/webgpuProbe';
import { getPublishedWebGpuProbe } from '../webgpu/webgpuProbe';

export function displayedWebGpuProbe(): WebGpuProbeResult | undefined {
  const published = getPublishedWebGpuProbe();
  return published.worker ?? published.main;
}

export function WebGpuHardFailBanner({ probe }: { probe?: WebGpuProbeResult }) {
  const json = JSON.stringify(
    probe ?? { ok: false, browser: 'unknown', reason: 'WebGPU probe failed', adapter: null },
    null,
    2,
  );
  return (
    <div className="preview-webgpu-hard-fail" role="alert">
      <p className="preview-webgpu-hard-fail-title">GPU preview unavailable</p>
      <p>
        WebGPU is required for this preview session. Canvas2D is not a GPU
        fallback. Adapter/device probe failed — compare Chrome vs Edge using
        the JSON below (also on <code>window.webgpuProbe</code>).
      </p>
      <pre className="preview-webgpu-probe-json">{json}</pre>
    </div>
  );
}
