import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, ClipTransition } from '../types';
import { extractThumbnails } from '../utils/media';
import { extractWaveformPeaks } from '../utils/waveform';
import {
  buildRulerTicks,
  clampPixelsPerSecond,
  clipPixelWidth,
  DEFAULT_PIXELS_PER_SECOND,
  formatTimelineTime,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  rulerTickInterval,
  timelineContentWidth,
} from '../utils/timelineLayout';
import { computeTotalDuration } from '../utils/transitions';
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

const TRANSITION_COLORS: Record<string, string> = {
  none: 'var(--border)',
  dissolve: '#7c4dff',
  motion: '#f06292',
};

interface ClipLayout {
  clip: Clip;
  index: number;
  duration: number;
  width: number;
  start: number;
}

// ─── Time Ruler ─────────────────────────────────────────────────────────────

interface RulerProps {
  totalDuration: number;
  pixelsPerSecond: number;
}

function TimelineRuler({ totalDuration, pixelsPerSecond }: RulerProps) {
  if (totalDuration <= 0) return null;

  const contentWidth = timelineContentWidth(totalDuration, pixelsPerSecond);
  const interval = rulerTickInterval(totalDuration);
  const ticks = buildRulerTicks(totalDuration, interval);

  return (
    <div className="timeline-ruler" style={{ width: contentWidth }} aria-hidden="true">
      {ticks.map((tick) => (
        <span
          key={tick}
          className={`ruler-tick${tick === 0 ? ' ruler-tick--start' : ''}`}
          style={{ left: tick === 0 ? 0 : tick * pixelsPerSecond }}
        >
          <span className="ruler-tick-label">{formatTimelineTime(tick)}</span>
        </span>
      ))}
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
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Drag-and-drop state ──────────────────────────────────────────────────
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const touchDragRef = useRef<number | null>(null);
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const clipLayouts = useMemo<ClipLayout[]>(() => {
    let cursor = 0;
    return clips.map((clip, index) => {
      const duration = effectiveDur(clip);
      const width = clipPixelWidth(duration, pixelsPerSecond);
      const layout = { clip, index, duration, width, start: cursor };
      cursor += width;
      return layout;
    });
  }, [clips, pixelsPerSecond]);

  const totalDuration = useMemo(
    () => clips.reduce((sum, clip) => sum + effectiveDur(clip), 0),
    [clips],
  );
  const outputDuration = useMemo(
    () => computeTotalDuration(clips, transitions),
    [clips, transitions],
  );
  const contentWidth = timelineContentWidth(totalDuration, pixelsPerSecond);

  const calcInsertIndex = (clientX: number): number => {
    const track = trackRef.current;
    const scroll = scrollRef.current;
    if (!track || !scroll) return 0;

    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft;

    for (const layout of clipLayouts) {
      const midpoint = layout.start + layout.width / 2;
      if (x < midpoint) return layout.index;
    }
    return clipLayouts.length;
  };

  const adjustZoom = (factor: number) => {
    setPixelsPerSecond((current) => clampPixelsPerSecond(current * factor));
  };

  const scrollTimeline = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  // Attach non-passive touchmove listener so we can call preventDefault
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (touchDragRef.current !== null) e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setPixelsPerSecond((current) => clampPixelsPerSecond(current * factor));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── HTML5 Drag handlers (desktop) ────────────────────────────────────────
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetIndex(calcInsertIndex(e.clientX));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndex ?? Number(e.dataTransfer.getData('text/plain'));
    const insertBefore = calcInsertIndex(e.clientX);
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
    if (lastTouchPos.current) {
      const dx = Math.abs(touch.clientX - lastTouchPos.current.x);
      const dy = Math.abs(touch.clientY - lastTouchPos.current.y);
      if (dx < 4 && dy < 4) return;
    }
    lastTouchPos.current = { x: touch.clientX, y: touch.clientY };
    setDropTargetIndex(calcInsertIndex(touch.clientX));
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
          {formatTimelineTime(outputDuration)} total
          {outputDuration !== totalDuration && (
            <span className="timeline-total-note"> ({formatTimelineTime(totalDuration)} source)</span>
          )}
        </span>
        <div className="timeline-zoom-controls">
          <button
            type="button"
            className="timeline-zoom-btn"
            onClick={() => adjustZoom(1 / 1.25)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
          <input
            type="range"
            className="timeline-zoom-slider"
            min={MIN_PIXELS_PER_SECOND}
            max={MAX_PIXELS_PER_SECOND}
            step={4}
            value={pixelsPerSecond}
            onChange={(e) => setPixelsPerSecond(clampPixelsPerSecond(Number(e.target.value)))}
            aria-label="Timeline zoom"
            title="Timeline zoom"
          />
          <button
            type="button"
            className="timeline-zoom-btn"
            onClick={() => adjustZoom(1.25)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="timeline-scroll-btn"
            onClick={() => scrollTimeline(-Math.max(160, scrollRef.current?.clientWidth ? scrollRef.current.clientWidth * 0.6 : 160))}
            aria-label="Scroll timeline left"
            title="Scroll left"
          >
            ←
          </button>
          <button
            type="button"
            className="timeline-scroll-btn"
            onClick={() => scrollTimeline(Math.max(160, scrollRef.current?.clientWidth ? scrollRef.current.clientWidth * 0.6 : 160))}
            aria-label="Scroll timeline right"
            title="Scroll right"
          >
            →
          </button>
        </div>
      </div>
      <p className="timeline-hint muted">Drag clips to reorder. Shift + scroll wheel zooms the timeline.</p>

      <div className="timeline-scroll-container" ref={scrollRef}>
        <TimelineRuler totalDuration={totalDuration} pixelsPerSecond={pixelsPerSecond} />

        <div
          className="timeline-track"
          ref={trackRef}
          style={{ width: contentWidth }}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onTouchMove={handleTouchMoveOnTrack}
          onTouchEnd={handleTouchEnd}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDropTargetIndex(null);
            }
          }}
        >
          {clipLayouts.map(({ clip, index, duration, width, start }) => {
            const thumbs = thumbMap[clip.id];
            const waves = waveMap[clip.id];
            const isLoadingThumbs = clip.kind === 'video' && thumbs === undefined;
            const isLoadingWave = clip.kind === 'audio' && waves === undefined;
            const transition = index > 0 ? transMap.get(index) : undefined;

            const showIndicatorBefore =
              dropTargetIndex === index &&
              dragIndex !== null &&
              dragIndex !== index &&
              dragIndex !== index - 1;

            return (
              <Fragment key={clip.id}>
                {showIndicatorBefore && (
                  <div
                    className="timeline-drop-indicator"
                    style={{ left: start }}
                    aria-hidden="true"
                  />
                )}

                {transition && (
                  <button
                    type="button"
                    className={`transition-zone transition-zone--overlay${transition.type !== 'none' ? ' active' : ''}`}
                    style={{
                      left: start - 12,
                      '--tz-color': TRANSITION_COLORS[transition.type],
                    } as React.CSSProperties}
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
                  className={`timeline-clip-wrapper${dragIndex === index ? ' is-dragging' : ''}`}
                  style={{ width }}
                  data-clip-index={index}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragEnd={handleDragEnd}
                  onTouchStart={() => handleTouchStart(index)}
                >
                  <div
                    className={`timeline-clip${clip.kind === 'audio' ? ' timeline-clip--audio' : ''}${
                      clip.id === selectedClipId ? ' selected' : ''
                    }`}
                    onClick={() => onSelect(clip.id)}
                    title={clip.title}
                  >
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

                      <span className="timeline-clip-dur">{duration.toFixed(1)}s</span>

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

          {dropTargetIndex === clips.length &&
            dragIndex !== null &&
            dragIndex !== clips.length - 1 && (
              <div
                className="timeline-drop-indicator"
                style={{ left: contentWidth }}
                aria-hidden="true"
              />
            )}
        </div>
      </div>

      {editingTransition && (
        <TransitionEditor
          transition={editingTransition}
          clipATitle={clips[editingTransition.afterClipIndex - 1]?.title ?? 'Previous clip'}
          clipBTitle={clips[editingTransition.afterClipIndex]?.title ?? 'Next clip'}
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
