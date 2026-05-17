import { useEffect, useRef, useState } from 'react';
import type { BrowserCapabilities } from '../utils/feature-detector';
import { detectCapabilities } from '../utils/feature-detector';

interface Props {
  onAddClips: (files: File[]) => void;
  onMerge: () => void;
  onSaveProject: () => void;
  onLoadProject: (file: File) => void;
  status: string;
  forceFFmpeg: boolean;
  onToggleForceFFmpeg: (v: boolean) => void;
}

export function Toolbar({
  onAddClips,
  onMerge,
  onSaveProject,
  onLoadProject,
  status,
  forceFFmpeg,
  onToggleForceFFmpeg,
}: Props) {
  const clipInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);

  useEffect(() => {
    detectCapabilities().then(setCaps).catch(() => {});
  }, []);

  const handleClipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onAddClips(files);
    e.target.value = '';
  };

  const handleProjectFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onLoadProject(file);
    e.target.value = '';
  };

  const gpuAvailable = caps?.hardwareH264 && caps?.webcodecs;
  const gpuLabel = gpuAvailable ? '⚡ GPU' : '🖥 CPU';
  const gpuTitle = caps
    ? `WebCodecs: ${caps.webcodecs ? 'yes' : 'no'} · Hardware H.264: ${caps.hardwareH264 ? 'yes' : 'no'} · WebGPU: ${caps.webgpu ? 'yes' : 'no'}`
    : 'Detecting capabilities...';

  return (
    <>
      <div className="toolbar">
        <label className="button-like">
          Add clips (MP4 / WAV / MP3)
          <input
            ref={clipInputRef}
            type="file"
            accept="video/mp4,audio/wav,audio/x-wav,audio/mpeg,.mp4,.wav,.mp3"
            multiple
            onChange={handleClipChange}
          />
        </label>
        <button type="button" className="btn-primary" onClick={onMerge}>
          ▶ Render
        </button>
        <button type="button" onClick={onSaveProject}>
          Save project
        </button>
        <button type="button" onClick={() => projectFileInputRef.current?.click()}>
          Load project
        </button>
        <input
          ref={projectFileInputRef}
          type="file"
          accept="application/json"
          hidden
          onChange={handleProjectFileChange}
        />

        {/* Encoder toggle */}
        <div className="encoder-badge" title={gpuTitle}>
          <span className="encoder-indicator">{gpuLabel}</span>
          {gpuAvailable && (
            <label className="encoder-toggle-label">
              <input
                type="checkbox"
                checked={forceFFmpeg}
                onChange={(e) => onToggleForceFFmpeg(e.target.checked)}
              />
              Force CPU
            </label>
          )}
        </div>
      </div>
      <p aria-live="polite" style={{ minHeight: '1.4rem', color: 'var(--muted)', margin: '0.5rem 0 0' }}>
        {status}
      </p>
    </>
  );
}

