import { useEffect, useState } from 'react';
import { previewMetrics } from '../composition/previewMetrics';
import { formatGpuProfile, isGpuProfilingRequested } from '../webgpu/gpuProfiler';

/** How often the overlay re-reads the averages (they are EMAs, so this is plenty). */
const REFRESH_MS = 500;
/** Passes shown, slowest first. */
const SHOWN_PASSES = 8;

/**
 * `?gpu_profile` dev overlay under the Effects Stack: the preview's GPU time
 * per pass ("NR nlm 6.2 ms · bloom 1.8 ms · compositor 0.4 ms"). Renders
 * nothing without the parameter.
 */
export function GpuProfileOverlay() {
  const enabled = isGpuProfilingRequested();
  const [line, setLine] = useState('');

  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const passes = previewMetrics.snapshot().gpuPassMs;
      const total = Object.values(passes).reduce((sum, ms) => sum + ms, 0);
      const text = formatGpuProfile(passes, SHOWN_PASSES);
      setLine(text ? `${text} — ${total.toFixed(1)} ms total` : '');
    };
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className="gpu-profile-overlay" role="status" aria-label="GPU time per pass">
      <span className="gpu-profile-overlay-label">GPU</span>{' '}
      {line || 'waiting for a profiled frame (needs timestamp-query)…'}
    </div>
  );
}
