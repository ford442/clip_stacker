import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { editorStore } from '../../store/editorStore';
import { allSequenceClips } from '../../timeline/sequenceModel';
import {
  driveItemForOffline,
  libraryMedia,
  relinkFromDrive,
  relinkOfflineClips,
} from '../../actions/interchangeActions';

interface Props {
  onClose: () => void;
}

/**
 * File → Relink media…: every offline clip, with a library pick, a file pick
 * and (when the Drive library has it) a Drive download per row, plus
 * "Relink all from folder…", which matches by file name, then content hash.
 * Each relink is one undo step; trims and settings stay.
 */
export function RelinkMediaDialog({ onClose }: Props) {
  const offline = useStore(editorStore, useShallow((s) => allSequenceClips(s).filter((clip) => Boolean(clip.offline))));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const library = libraryMedia();

  const run = async (task: () => Promise<{ relinked: number; remaining: number }>) => {
    setBusy(true);
    setMessage(null);
    try {
      const { relinked, remaining } = await task();
      setMessage(`Relinked ${relinked} clip${relinked === 1 ? '' : 's'}; ${remaining} still offline.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="relink-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content interchange-dialog">
        <div className="modal-header">
          <h2 id="relink-title">Relink media</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {offline.length === 0 ? (
            <p className="inspector-hint">No clip is offline.</p>
          ) : (
            <table className="relink-table">
              <thead>
                <tr>
                  <th scope="col">Clip</th>
                  <th scope="col">Missing file</th>
                  <th scope="col">Relink from</th>
                </tr>
              </thead>
              <tbody>
                {offline.map((clip) => {
                  const drive = driveItemForOffline(clip);
                  return (
                    <tr key={clip.id}>
                      <td>{clip.title}</td>
                      <td title={clip.offline?.url ?? ''}>{clip.offline?.fileName}</td>
                      <td className="relink-actions">
                        <select
                          aria-label={`Library media for ${clip.title}`}
                          value=""
                          disabled={busy || library.length === 0}
                          onChange={(e) => {
                            const picked = library[Number(e.target.value)];
                            if (picked) void run(() => relinkOfflineClips({ assignments: [{ clipId: clip.id, file: picked.file }] }));
                          }}
                        >
                          <option value="">Library…</option>
                          {library.map((item, i) => (
                            <option key={`${item.name}-${i}`} value={i}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                        <label className="button-like btn-secondary">
                          File…
                          <input
                            type="file"
                            hidden
                            disabled={busy}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (file) void run(() => relinkOfflineClips({ assignments: [{ clipId: clip.id, file }] }));
                            }}
                          />
                        </label>
                        {drive && (
                          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(() => relinkFromDrive(clip.id))} title={`Download ${drive.name} from Google Drive`}>
                            Drive
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {message && (
            <p className="inspector-hint" role="status">
              {message}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" disabled={busy || offline.length === 0} onClick={() => folderInput.current?.click()} title="Pick a folder: files are matched by name, then by content">
            Relink all from folder…
          </button>
          <input
            ref={folderInput}
            type="file"
            hidden
            multiple
            {...{ webkitdirectory: '' }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length > 0) void run(() => relinkOfflineClips({ files }));
            }}
          />
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
