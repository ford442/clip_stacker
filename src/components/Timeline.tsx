import { useEffect, useRef, useState } from 'react';
import type { Clip } from '../types';
import { extractThumbnails } from '../utils/media';

interface Props {
  clips: Clip[];
  selectedClipId: string | null;
  onSelect: (id: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

function effectiveDur(clip: Clip): number {
  const end = isNaN(clip.trimEnd) ? clip.duration : clip.trimEnd;
  return Math.max(0.1, end - clip.trimStart);
}

export function Timeline({ clips, selectedClipId, onSelect, onMoveUp, onMoveDown }: Props) {
  const [thumbMap, setThumbMap] = useState<Record<string, string[]>>({});
  const generating = useRef<Set<string>>(new Set());
  const completed = useRef<Set<string>>(new Set());

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
      <section className="panel">
        <h2>Timeline</h2>
        <p className="muted">No clips added yet.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Timeline</h2>
      <div className="timeline-track">
        {clips.map((clip, index) => {
          const dur = effectiveDur(clip);
          const thumbs = thumbMap[clip.id];
          const isLoading = clip.kind === 'video' && thumbs === undefined;
          return (
            <div
              key={clip.id}
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
          );
        })}
      </div>
    </section>
  );
}
