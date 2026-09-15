import type { Clip } from '../../types';
import { formatGpuChoreDiagnostics, gpuComputeAvailable } from '../../gpu-chores/diagnostics';

export function GpuChoreLevelsPanel({ clip }: { clip: Clip }) {
  const bins = clip.lumaHistogram;
  const max = bins && bins.length ? Math.max(...bins, 1) : 1;
  const avail = gpuComputeAvailable();
  return (
    <div className="inspector-gpu-chores">
      <div className="inspector-group-label">Levels (Rec.709 luma)</div>
      {bins && bins.length === 256 ? (
        <div className="luma-histogram" role="img" aria-label="Luminance histogram">
          {bins.map((count, i) => (
            <span
              key={i}
              className="luma-histogram-bar"
              style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
            />
          ))}
        </div>
      ) : (
        <p className="inspector-hint">Analyzing still with gpu-chores…</p>
      )}
      {clip.lumaLevels && (
        <p className="inspector-hint">
          Black {clip.lumaLevels.black} · mean {clip.lumaLevels.mean.toFixed(1)} · white {clip.lumaLevels.white}
        </p>
      )}
      <p className="inspector-hint inspector-gpu-chore-crumb">
        {clip.gpuChoreBackend
          ? `chores: ${clip.gpuChoreBackend} — ${clip.gpuChoreReason}`
          : formatGpuChoreDiagnostics()}
        {' · '}
        gpuComputeAvailable: {avail.available ? 'yes' : 'no'} ({avail.reason})
      </p>
    </div>
  );
}
