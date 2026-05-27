import { Fragment, useEffect, useRef, useState } from 'react';
import type { Clip, ClipTransition } from '../types';
import { extractThumbnails } from '../utils/media';
import { extractWaveformPeaks } from '../utils/waveform';
import { WaveformCanvas } from './WaveformCanvas';
import { TransitionEditor } from './TransitionEditor';

interface Props {
  clips: Clip[];
  selectedClipId: string | null;
  transitions: ClipTransition[];
  onSelect: (id: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onReorder: (fromIndex: number, insertBefore: number) => void;
  onTransitionUpdate: (updated: ClipTransition) => void;
  onDelete: (id: string) => void;
}

function effectiveDur(clip: Clip): number {
  const end = isNaN(clip.trimEnd) ? clip.duration : clip.trimEnd;
  return Math.max(0.1, end - clip.trimStart);
}

/** Choose a human-friendly tick interval (seconds) for the given total duration. */
function rulerTickInterval(totalDur: number): number {
  if (totalDur <= 15) return 1;
  if (totalDur <= 60) return 5;
  if (totalDur <= 300) return 15;
  if (totalDur <= 600) return 30;
  return 60;
}

/** Format seconds as m:ss or just s.d */
function fmtTime(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const TRANSITION_COLORS: Record<string, string> = {
  none: 'var(--border)',
  dissolve: '#7c4dff',
  motion: '#f06292',
};

// ─── Time Ruler ─────────────────────────────────────────────────────────────

interface RulerProps {
  clips: Clip[];
  transitions: ClipTransition[];
}

function TimelineRuler({ clips, transitions }: RulerProps) {
  const totalDur = clips.reduce((sum, c) => sum + effectiveDur(c), 0);
  if (totalDur <= 0) return null;

  const interval = rulerTickInterval(totalDur);
  const transSet = new Set(transitions.map((t) => t.afterClipIndex));

  // Build per-clip ruler segments sharing the same flex sizing as the track
  let cursor = 0;
  return (
    <div className="timeline-ruler" aria-hidden="true">
      {clips.map((clip, index) => {
        const dur = effectiveDur(clip);
        const clipStart = cursor;
        cursor += dur;

        // Which tick labels fall inside this clip?
        const firstTick = Math.ceil(clipStart / interval) * interval;
        const ticks: number[] = [];
        for (let t = firstTick; t < clipStart + dur - 0.01; t += interval) {
          ticks.push(t);
        }

        const hasTransition = index > 0 && transSet.has(index);

        return (
          <div key={clip.id} className="timeline-ruler-clip-group">
            {/* Gap for the transition zone that precedes this clip */}
            {hasTransition && <div className="timeline-ruler-gap" />}

            <div className="timeline-ruler-seg" style={{ flex: `${dur} 0 0px` }}>
              {/* Start-of-clip label (always show) */}
              <span className="ruler-tick ruler-tick--start">
                <span className="ruler-tick-label">{fmtTime(clipStart)}</span>
              </span>

              {/* Interior ticks */}
              {ticks.map((t) => {
                const pct = ((t - clipStart) / dur) * 100;
                return (
                  <span
                    key={t}
                    className="ruler-tick"
                    style={{ left: `${pct}%` }}
                  >
                    <span className="ruler-tick-label">{fmtTime(t)}</span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* End label */}
      <div className="timeline-ruler-end">
        <span className="ruler-tick-label">{fmtTime(totalDur)}</span>
      </div>
    </div>
  );
}

// ─── Main Timeline ───────────────────────────────────────────────────────────

export function Timeline({
  clips,
  selectedClipId,
  transitions,
  onSelect,
  onMoveUp,
  onMoveDown,
  onReorder,
  onTransitionUpdate,
  onDelete,
}: Props) {
  const [thumbMap, setThumbMap] = useState<Record<string, string[]>>({});
  const [waveMap, setWaveMap] = useState<Record<string, Float32Array>>({});
  const generatingThumbs = useRef<Set<string>>(new Set());
  const completedThumbs = useRef<Set<string>>(new Set());
  const generatingWaves = useRef<Set<string>>(new Set());
  const completedWaves = useRef<Set<string>>(new Set());
  const [editingTransition, setEditingTransition] = useState<ClipTransition | null>(null);

  // ── Drag-and-drop state ──────────────────────────────────────────────────
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const touchDragRef = useRef<number | null>(null);
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // Attach non-passive touchmove listener so we can call preventDefault
  // (React synthetic events cannot prevent scroll via passive handlers)
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (touchDragRef.current !== null) e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  /** Determine insertion position (0…n) from pointer/touch x over a clip. */
  const calcInsertIndex = (clientX: number, wrapperEl: HTMLElement, clipIdx: number): number => {
    const rect = wrapperEl.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2 ? clipIdx : clipIdx + 1;
  };

  // ── HTML5 Drag handlers (desktop) ────────────────────────────────────────
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetIndex(calcInsertIndex(e.clientX, e.currentTarget as HTMLElement, index));
  };

  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    const from = dragIndex ?? Number(e.dataTransfer.getData('text/plain'));
    const insertBefore = calcInsertIndex(e.clientX, e.currentTarget as HTMLElement, index);
    onReorder(from, insertBefore);
    setDragIndex(null);
    setDropTargetIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDropTargetIndex(null);
  };

  // ── Touch handlers (mobile) ──────────────────────────────────────────────
  const handleTouchStart = (index: number) => {
    touchDragRef.current = index;
    lastTouchPos.current = null;
    setDragIndex(index);
  };

  const handleTouchMoveOnTrack = (e: React.TouchEvent) => {
    if (touchDragRef.current === null) return;
    const touch = e.touches[0];
    // Skip expensive hit-test when touch hasn't moved more than 4 px
    if (lastTouchPos.current) {
      const dx = Math.abs(touch.clientX - lastTouchPos.current.x);
      const dy = Math.abs(touch.clientY - lastTouchPos.current.y);
      if (dx < 4 && dy < 4) return;
    }
    lastTouchPos.current = { x: touch.clientX, y: touch.clientY };
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const wrapperEl = el?.closest('[data-clip-index]') as HTMLElement | null;
    if (!wrapperEl) {
      setDropTargetIndex(null);
      return;
    }
    const idx = Number(wrapperEl.dataset.clipIndex);
    setDropTargetIndex(calcInsertIndex(touch.clientX, wrapperEl, idx));
  };

  const handleTouchEnd = () => {
    if (touchDragRef.current !== null && dropTargetIndex !== null) {
      onReorder(touchDragRef.current, dropTargetIndex);
    }
    touchDragRef.current = null;
    lastTouchPos.current = null;
    setDragIndex(null);
    setDropTargetIndex(null);
  };

  const transMap = new Map(transitions.map((t) => [t.afterClipIndex, t]));

  // Thumbnail generation for video clips
  useEffect(() => {
    for (const clip of clips) {
      if (clip.kind !== 'video') continue;
      if (completedThumbs.current.has(clip.id)) continue;
      if (generatingThumbs.current.has(clip.id)) continue;
      generatingThumbs.current.add(clip.id);
      const dur = effectiveDur(clip);
      const count = Math.max(2, Math.min(8, Math.ceil(dur / 3)));
      extractThumbnails(clip.objectUrl, clip.duration, clip.trimStart, clip.trimEnd, count).then(
        (thumbs) => {
          generatingThumbs.current.delete(clip.id);
          completedThumbs.current.add(clip.id);
          setThumbMap((prev) => ({ ...prev, [clip.id]: thumbs }));
        },
      );
    }
  }, [clips]);

  // Waveform generation for audio clips
  useEffect(() => {
    for (const clip of clips) {
      if (clip.kind !== 'audio') continue;
      if (completedWaves.current.has(clip.id)) continue;
      if (generatingWaves.current.has(clip.id)) continue;
      generatingWaves.current.add(clip.id);
      extractWaveformPeaks(clip.objectUrl, 120).then(
        (peaks) => {
          generatingWaves.current.delete(clip.id);
          completedWaves.current.add(clip.id);
          setWaveMap((prev) => ({ ...prev, [clip.id]: peaks }));
        },
        () => {
          // Ignore errors — clip stays without waveform
          generatingWaves.current.delete(clip.id);
          completedWaves.current.add(clip.id);
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
      <div className="timeline-header-row">
        <h2>Timeline</h2>
        <span className="timeline-total-dur muted">
          {fmtTime(clips.reduce((s, c) => s + effectiveDur(c), 0))} total
        </span>
      </div>

      <div className="timeline-scroll-container">
        <TimelineRuler clips={clips} transitions={transitions} />

        <div
          className="timeline-track"
          ref={trackRef}
          onTouchMove={handleTouchMoveOnTrack}
          onTouchEnd={handleTouchEnd}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDropTargetIndex(null);
            }
          }}
        >
           {clips.map((clip, index) => {
            const dur = effectiveDur(clip);
            const thumbs = thumbMap[clip.id];
            const waves = waveMap[clip.id];
            const isLoadingThumbs = clip.kind === 'video' && thumbs === undefined;
            const isLoadingWave = clip.kind === 'audio' && waves === undefined;
            const transition = index > 0 ? transMap.get(index) : undefined;

            // Show insertion indicator before this clip when it is the drop target
            const showIndicatorBefore =
              dropTargetIndex === index &&
              dragIndex !== null &&
              dragIndex !== index &&
              dragIndex !== index - 1;

            return (
              <Fragment key={clip.id}>
                {showIndicatorBefore && (
                  <div className="timeline-drop-indicator" aria-hidden="true" />
                )}

                <div
                  className={`timeline-clip-wrapper${dragIndex === index ? ' is-dragging' : ''}`}
                  data-clip-index={index}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  onTouchStart={() => handleTouchStart(index)}
                >
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

                  {/* === MAIN CLIP CONTENT (Combined) === */}
                  <div
                    className={`timeline-clip${clip.kind === 'audio' ? ' timeline-clip--audio' : ''}${
                      clip.id === selectedClipId ? ' selected' : ''
                    }`}
                    style={{ flex: `${dur} 0 0px` }}
                    onClick={() => onSelect(clip.id)}
                    title={clip.title}
                  >
                    {/* Thumbnail / waveform area */}
                    {clip.kind === 'video' ? (
                      <div className={`timeline-thumbs${isLoadingThumbs ? ' is-loading' : ''}`}>
                        {thumbs?.map((src, ti) => <img key={ti} src={src} alt="" />) ?? null}
                      </div>
                    ) : (
                      <div className={`timeline-waveform${isLoadingWave ? ' is-loading' : ''}`}>
                        {waves ? (
                          <WaveformCanvas peaks={waves} height={54} />
                        ) : (
                          <span className="waveform-loading-icon">♫</span>
                        )}
                      </div>
                    )}

                    <div className="timeline-clip-footer">
                      <span
                        className="timeline-drag-handle"
                        role="img"
                        aria-label="Drag handle — drag to reorder clip"
                        title="Drag to reorder"
                      >
                        ⠿
                      </span>

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
                        <button
                          type="button"
                          className="project-delete-btn"
                          onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
                          title="Delete clip"
                          aria-label="Delete clip"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              </Fragment>
            );
          })}

          {/* Insertion indicator after the last clip */}
          {dropTargetIndex === clips.length &&
            dragIndex !== null &&
            dragIndex !== clips.length - 1 && (
              <div className="timeline-drop-indicator" aria-hidden="true" />
            )}
        </div>
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

