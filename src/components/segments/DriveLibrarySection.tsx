import { useState } from 'react';
import type { DriveMediaItem } from '../../types';
import { useDriveLibraryItems, driveLibraryActions } from '../../store';
import { segmentActions } from '../../store/segmentStore';
import { useSegmentWorkflow } from '../../hooks/useSegmentWorkflow';
import { fetchSegmentBlob } from '../../utils/segments/segmentDeps';
import { formatBytes } from '../../utils/memory';
import type { MediaLibraryItem } from '../../utils/project';
import { SegmentSessionView } from './SegmentSessionView';

interface Props {
  onAddClip: (item: MediaLibraryItem) => Promise<void>;
  onAddFiles: (files: File[]) => Promise<void>;
}

function DriveRow({ item, onAddClip, onAddFiles }: { item: DriveMediaItem } & Props) {
  const workflow = useSegmentWorkflow();
  const [open, setOpen] = useState(false);
  const [startText, setStartText] = useState('0');
  const [endText, setEndText] = useState('10');

  const { session } = workflow;
  const mine = session?.request.source.kind === 'drive' && session.request.source.fileId === item.fileId;
  const busy = session?.phase === 'working';
  const start = Number(startText);
  const end = Number(endText);
  const invalid = !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 0.1;
  const stem = item.name.replace(/\.[^.]+$/, '') || 'drive';
  const outputName = `${stem}_${start.toFixed(2)}-${end.toFixed(2)}.mp4`;

  const addToTimeline = async () => {
    const result = session?.result;
    if (!result) return;
    if (result.backend === 'contabo' && result.mediaName) {
      // A real library file: the clip can reuse its URL.
      await onAddClip({ name: result.mediaName, url: result.url });
    } else {
      // A browser-side cut lives in a blob: URL that must never become a clip's remote URL.
      const blob = await fetchSegmentBlob(result.url);
      await onAddFiles([new File([blob], outputName, { type: blob.type || 'video/mp4' })]);
    }
    // The file is on the timeline (or in the library) now; keep it on the server.
    segmentActions.setSession(null);
  };

  return (
    <li className="drive-library-row">
      <div className="drive-library-line">
        <span className="media-library-name" title={item.name}>
          ☁ {item.name}
        </span>
        <span className="media-library-meta">{item.size > 0 ? formatBytes(item.size) : 'size unknown'}</span>
        <button type="button" className="btn-secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          Extract segment…
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => driveLibraryActions.removeItem(item.fileId)}
          title="Remove this reference (the file stays in Drive)"
        >
          Remove
        </button>
      </div>
      {open && (
        <div className="segment-range">
          <label>
            Start (s)
            <input type="number" min="0" step="0.01" value={startText} onChange={(e) => setStartText(e.target.value)} />
          </label>
          <label>
            End (s)
            <input type="number" min="0" step="0.01" value={endText} onChange={(e) => setEndText(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={invalid || busy}
            onClick={() => void workflow.extract({ kind: 'drive', fileId: item.fileId }, { startSec: start, endSec: end }, outputName)}
          >
            Cut
          </button>
        </div>
      )}
      {mine && session && (
        <SegmentSessionView
          session={session}
          onCancel={workflow.cancel}
          onDiscard={workflow.discard}
          onImport={() => {}}
          downloadName={outputName}
          action={
            <button type="button" className="btn-primary" onClick={() => void addToTimeline()}>
              Add to timeline
            </button>
          }
        />
      )}
    </li>
  );
}

/** Google Drive files imported as references (the media library's “Drive” group). */
export function DriveLibrarySection({ onAddClip, onAddFiles }: Props) {
  const items = useDriveLibraryItems();
  if (items.length === 0) return null;
  return (
    <div className="drive-library">
      <div className="media-library-header">
        <h3>Google Drive</h3>
      </div>
      <p className="storage-hint">References only — files stay in Drive. Large ones are cut on the server.</p>
      <ul className="media-library-list">
        {items.map((item) => (
          <DriveRow key={item.fileId} item={item} onAddClip={onAddClip} onAddFiles={onAddFiles} />
        ))}
      </ul>
    </div>
  );
}
