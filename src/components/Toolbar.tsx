import { useRef } from 'react';

interface Props {
  onAddClips: (files: File[]) => void;
  onMerge: () => void;
  onSaveProject: () => void;
  onLoadProject: (file: File) => void;
  status: string;
}

export function Toolbar({ onAddClips, onMerge, onSaveProject, onLoadProject, status }: Props) {
  const clipInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);

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
        <button type="button" onClick={onMerge}>
          Render merged video
        </button>
        <button type="button" onClick={onSaveProject}>
          Save project
        </button>
        <button type="button" onClick={() => projectFileInputRef.current?.click()}>
          Load project
        </button>
        <input ref={projectFileInputRef} type="file" accept="application/json" hidden onChange={handleProjectFileChange} />
      </div>
      <p aria-live="polite" style={{ minHeight: '1.4rem', color: 'var(--muted)', margin: '0.5rem 0 0' }}>
        {status}
      </p>
    </>
  );
}
