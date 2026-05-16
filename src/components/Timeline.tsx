import type { Clip } from '../types';

interface Props {
  clips: Clip[];
  selectedClipId: string | null;
  onSelect: (id: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

export function Timeline({ clips, selectedClipId, onSelect, onMoveUp, onMoveDown }: Props) {
  return (
    <section className="panel">
      <h2>Timeline</h2>
      <p className="muted">
        Clips stay in project when adding new uploads; newest upload is auto-selected.
      </p>
      <ol className="timeline">
        {clips.map((clip, index) => (
          <li
            key={clip.id}
            className={`timeline-item${clip.id === selectedClipId ? ' selected' : ''}`}
            onClick={() => onSelect(clip.id)}
          >
            <div className="row">
              <strong>
                {index + 1}. {clip.title}
              </strong>
              <div className="timeline-buttons">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveUp(index);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveDown(index);
                  }}
                >
                  ↓
                </button>
              </div>
            </div>
            <div className="muted">
              Fade V(in/out): {clip.videoFadeIn.toFixed(1)}/{clip.videoFadeOut.toFixed(1)}s • A(in/out):{' '}
              {clip.audioFadeIn.toFixed(1)}/{clip.audioFadeOut.toFixed(1)}s
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
