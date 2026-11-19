import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { editorStore } from '../../store/editorStore';
import { renderJobStore } from '../../store/renderJobStore';
import { exportStemsFromEditor, type StemsDownload } from '../../actions/interchangeActions';
import type { WavSampleFormat } from '../../export/container/wavWriter';
import { STEM_NORMALIZE_LUFS } from '../../export/exportStems';
import { ProjectTimecodeFields } from './ProjectTimecodeFields';

interface Props {
  onClose: () => void;
}

/** File → Export stems…: one BWF per lane plus the master, zipped with the timeline. */
export function ExportStemsDialog({ onClose }: Props) {
  const lanes = useStore(
    editorStore,
    useShallow((s) => s.tracks.filter((t) => t.kind !== 'text' && t.items.length > 0)),
  );
  const isRendering = useStore(renderJobStore, (s) => s.isRendering);
  const progress = useStore(renderJobStore, (s) => s.progressValue);
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [format, setFormat] = useState<WavSampleFormat>('pcm24');
  const [includeMaster, setIncludeMaster] = useState(true);
  const [normalize, setNormalize] = useState(false);
  const [result, setResult] = useState<StemsDownload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = useMemo(() => lanes.filter((lane) => !unchecked.has(lane.id)).map((lane) => lane.id), [lanes, unchecked]);

  const run = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await exportStemsFromEditor({ trackIds: chosen, includeMaster, format, normalize }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="stems-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content interchange-dialog">
        <div className="modal-header">
          <h2 id="stems-title">Export stems</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body inspector-fields">
          <p className="inspector-hint">
            One Broadcast WAV per lane (after its FX, delay compensation and duck) and the master, 48 kHz, placed at the
            timecode start in Cubase, Pro Tools, Resolve or Reaper. Bundled with the timeline (OTIO) and a manifest.
          </p>
          <fieldset>
            <legend>Lanes</legend>
            {lanes.length === 0 && <p className="inspector-hint">No lane holds audio yet.</p>}
            {lanes.map((lane, i) => (
              <label key={lane.id} className="inspector-checkbox-label">
                <input
                  type="checkbox"
                  checked={!unchecked.has(lane.id)}
                  onChange={(e) =>
                    setUnchecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.delete(lane.id);
                      else next.add(lane.id);
                      return next;
                    })
                  }
                />
                {lane.label?.trim() || `${lane.kind === 'audio' ? 'Audio' : 'Video'} lane ${i + 1}`}
                {lane.muted ? ' (muted)' : ''}
              </label>
            ))}
            <label className="inspector-checkbox-label">
              <input type="checkbox" checked={includeMaster} onChange={(e) => setIncludeMaster(e.target.checked)} />
              Master (with the master bus and loudness target)
            </label>
          </fieldset>
          <label>
            Bit depth
            <select value={format} onChange={(e) => setFormat(e.target.value as WavSampleFormat)}>
              <option value="pcm24">24-bit PCM</option>
              <option value="float32">32-bit float</option>
            </select>
          </label>
          <label className="inspector-checkbox-label" title={`Gain each stem to ${STEM_NORMALIZE_LUFS} LUFS (EBU R 128); the master keeps its own loudness target.`}>
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
            Normalize each stem to {STEM_NORMALIZE_LUFS} LUFS
          </label>
          <ProjectTimecodeFields />
          {error && <p className="inspector-hint inspector-hint--error" role="alert">{error}</p>}
          {result && (
            <p className="inspector-hint" role="status">
              {result.files.length} files ·{' '}
              <a href={result.url} download={result.fileName}>
                Download {result.fileName}
              </a>
            </p>
          )}
        </div>
        <div className="modal-footer">
          {isRendering && progress !== null && <progress max={1} value={progress} />}
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn-primary" disabled={isRendering || (chosen.length === 0 && !includeMaster)} onClick={() => void run()}>
            {isRendering ? 'Exporting…' : 'Export stems'}
          </button>
        </div>
      </div>
    </div>
  );
}
