import type { Clip } from '../types';
import { getClipDuration } from '../utils/project';

interface Props {
  clips: Clip[];
  selectedClipId: string | null;
  onSelect: (id: string) => void;
}

export function ClipLibrary({ clips, selectedClipId, onSelect }: Props) {
  return (
    <section className="panel">
      <h2>Library</h2>
      <ul className="clip-list">
        {clips.map((clip) => (
          <li
            key={clip.id}
            className={`clip-item${clip.id === selectedClipId ? ' selected' : ''}`}
            onClick={() => onSelect(clip.id)}
          >
            <div className="row">
              <strong>{clip.title}</strong>
              <span className="muted">{clip.kind.toUpperCase()}</span>
            </div>
            <div className="muted">
              {getClipDuration(clip).toFixed(1)}s (trim {clip.trimStart.toFixed(1)}s →{' '}
              {Number.isFinite(clip.trimEnd) ? `${clip.trimEnd.toFixed(1)}s` : 'end'})
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
