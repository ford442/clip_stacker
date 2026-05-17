import { useEffect, useRef, useState } from 'react';
import type { Clip, ClipTransition } from '../types';
import { extractThumbnails } from '../utils/media';
import { TransitionEditor } from './TransitionEditor';

interface Props {
  clips: Clip[];
  selectedClipId: string | null;
  transitions: ClipTransition[];
  onSelect: (id: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onTransitionUpdate: (updated: ClipTransition) => void;
}

function effectiveDur(clip: Clip): number {
  const end = isNaN(clip.trimEnd) ? clip.duration : clip.trimEnd;
  return Math.max(0.1, end - clip.trimStart);
}

const TRANSITION_COLORS: Record<string, string> = {
  none: 'var(--border)',
  dissolve: '#7c4dff',
  motion: '#f06292',
};

export function Timeline({
  clips,
  selectedClipId,
  transitions,
  onSelect,
  onMoveUp,
  onMoveDown,
  onTransitionUpdate,
}: Props) {
  const [thumbMap, setThumbMap] = useState<Record<string, string[]>>({});
  const generating = useRef<Set<string>>(new Set());
  const completed = useRef<Set<string>>(new Set());
  const [editingTransition, setEditingTransition] = useState<ClipTransition | null>(null);

  const transMap = new Map(transitions.map((t) => [t.afterClipIndex, t]));

  useEffect(() => {
    for (const clip of clips) {
      if (clip.kind !== 'video') continue;
      if (completed.current.has(clip.id)) continue;
      if (generating.current.has(clip.id)) continue;
      generating.current.add(clip.id);
      const dur = effectiveDur(clip);
      const count = Math.max(2, Math.min(8, Math.ceil(dur / 3)));
      extractThumbnails(clip.objectUrl, clip.duration, clip.trimStart, clip.trimEnd, count).then(
        (thumbs) => {
          generating.current.delete(clip.id);
          completed.current.add(clip.id);
          setThumbMap((prev) => ({ ...prev, [clip.id]: thumbs }));
        },
      );
    }
  }, [clips]);

  if (clips.length === 0) {
    return (
      <section className="panel timeline-panel">
        <h2>Timeline</h2>
        <p className="muted">No clips added yet.</p>
      </section>
    );
  }

  return (
    <section className="panel timeline-panel">
      <h2>Timeline</h2>
      <div className="timeline-track">
        {clips.map((clip, index) => {
          const dur = effectiveDur(clip);
          const thumbs = thumbMap[clip.id];
          const isLoading = clip.kind === 'video' && thumbs === undefined;
          const transition = index > 0 ? transMap.get(index) : undefined;

          return (
            <div key={clip.id} className="timeline-clip-wrapper">
              {/* Transition zone between clips */}
              {transition && (
                <button
                  type="button"
                  className={`transition-zone${transition.type !== 'none' ? ' active' : ''}`}
                  style={{ '--tz-color': TRANSITION_COLORS[transition.type] } as React.CSSProperties}
                  onClick={() => setEditingTransition(transition)}
                  title={`Transition: ${transition.type}${transition.type !== 'none' ? ` (${transition.duration}s)` : ''}`}
                  aria-label={`Edit transition between clips ${index} and ${index + 1}`}
                >
                  <span className="tz-icon">⬡</span>
                  {transition.type !== 'none' && (
                    <span className="tz-label">{transition.duration}s</span>
                  )}
                </button>
              )}

              <div
                className={`timeline-clip${clip.id === selectedClipId ? ' selected' : ''}`}
                style={{ flex: `${dur} 0 0px` }}
                onClick={() => onSelect(clip.id)}
                title={clip.title}
              >
                <div className={`timeline-thumbs${isLoading ? ' is-loading' : ''}`}>
                  {clip.kind === 'video' ? (
                    thumbs?.map((src, ti) => <img key={ti} src={src} alt="" />) ?? null
                  ) : (
                    <div className="thumb-audio">♫</div>
                  )}
                </div>
                <div className="timeline-clip-footer">
                  <span className="timeline-clip-label">
                    {index + 1}. {clip.title}
                  </span>
                  <span className="timeline-clip-dur">{dur.toFixed(1)}s</span>
                  <span className="timeline-clip-btns">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onMoveUp(index); }}
                      disabled={index === 0}
                      aria-label="Move clip left"
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onMoveDown(index); }}
                      disabled={index === clips.length - 1}
                      aria-label="Move clip right"
                    >
                      →
                    </button>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editingTransition && (
        <TransitionEditor
          transition={editingTransition}
          clipATitle={clips[editingTransition.afterClipIndex - 1]?.title ?? 'Clip A'}
          clipBTitle={clips[editingTransition.afterClipIndex]?.title ?? 'Clip B'}
          onUpdate={(updated) => {
            onTransitionUpdate(updated);
            setEditingTransition(updated);
          }}
          onClose={() => setEditingTransition(null)}
        />
      )}
    </section>
  );
}

