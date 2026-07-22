import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Clip, ClipTransition } from '../types';
import {
  buildRulerTicks,
  clampPixelsPerSecond,
  clipPixelWidth,
  DEFAULT_PIXELS_PER_SECOND,
  formatTimelineTime,
  MAX_PIXELS_PER_SECOND,
  MIN_CLIP_PIXEL_WIDTH,
  MIN_PIXELS_PER_SECOND,
  rulerTickInterval,
  timelineContentWidth,
} from '../utils/timelineLayout';
import { buildBeatMarkerLayouts } from '../utils/beatMarkers';
import {
  cancelTimelineMediaForClip,
  getCachedThumbnails,
  getCachedWaveform,
  orphanTransitionIndices,
  requestTimelineThumbnails,
  requestTimelineWaveform,
} from '../utils/timelineMediaCache';
import { computeTotalDuration } from '../utils/transitions';
import type { VirtualClipLayout } from './timelineClipTypes';
import { TransitionEditor } from './TransitionEditor';
import { VirtualClipBlock } from './VirtualClipBlock';

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
  morphProcessingIndex?: number | null;
}

function effectiveDur(clip: Clip): number {
  const end = Number.isNaN(clip.trimEnd) ? clip.duration : clip.trimEnd;
  return Math.max(0.1, end - clip.trimStart);
}

const TRANSITION_COLORS: Record<string, string> = {
  none: 'var(--border)',
  dissolve: '#7c4dff',
  motion: '#f06292',
  morph: '#26c6da',
};

const VIRTUAL_OVERSCAN = 3;

// ─── Time Ruler ─────────────────────────────────────────────────────────────

interface RulerProps {
  totalDuration: number;
  pixelsPerSecond: number;
  beatMarkers?: { clipId: string; sourceTime: number; leftPx: number }[];
}

function TimelineRuler({ totalDuration, pixelsPerSecond, beatMarkers = [] }: RulerProps) {
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
      {beatMarkers.map((m) => (
        <span
          key={`${m.clipId}-${m.sourceTime}`}
          className="ruler-beat-marker"
          style={{ left: m.leftPx }}
          title={`Beat @ ${m.sourceTime.toFixed(2)}s`}
        />
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
  morphProcessingIndex = null,
}: Props) {
  const [thumbMap, setThumbMap] = useState<Record<string, string[]>>({});
  const [waveMap, setWaveMap] = useState<Record<string, Float32Array>>({});
  const [editingTransition, setEditingTransition] = useState<ClipTransition | null>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Drag-and-drop state ──────────────────────────────────────────────────
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const touchDragRef = useRef<number | null>(null);
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const clipLayouts = useMemo<VirtualClipLayout[]>(() => {
    let cursor = 0;
    return clips.map((clip, index) => {
      const duration = effectiveDur(clip);
      const width = clipPixelWidth(duration, pixelsPerSecond);
      const layout = { clip, index, duration, width, start: cursor };
      cursor += width;
      return layout;
    });
  }, [clips, pixelsPerSecond]);

  const beatMarkers = useMemo(() => buildBeatMarkerLayouts(clipLayouts), [clipLayouts]);

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: clipLayouts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => clipLayouts[index]?.width ?? MIN_CLIP_PIXEL_WIDTH,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => clipLayouts[index]?.clip.id ?? index,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const visibleIndexSet = useMemo(() => {
    const indices = new Set(virtualItems.map((item) => item.index));
    if (dragIndex !== null) indices.add(dragIndex);
    return indices;
  }, [virtualItems, dragIndex]);

  const onThumbsLoaded = useCallback((clipId: string, thumbs: string[]) => {
    setThumbMap((prev) => (prev[clipId] ? prev : { ...prev, [clipId]: thumbs }));
  }, []);

  const onWavesLoaded = useCallback((clipId: string, peaks: Float32Array) => {
    setWaveMap((prev) => (prev[clipId] ? prev : { ...prev, [clipId]: peaks }));
  }, []);

  useEffect(() => {
    const visibleClipIds = new Set<string>();

    for (const index of visibleIndexSet) {
      const layout = clipLayouts[index];
      if (!layout) continue;
      const { clip } = layout;
      visibleClipIds.add(clip.id);

      if (clip.kind === 'video') {
        const cached = getCachedThumbnails(clip.id);
        if (cached) {
          setThumbMap((prev) => (prev[clip.id] ? prev : { ...prev, [clip.id]: cached }));
        } else {
          requestTimelineThumbnails(clip, onThumbsLoaded);
        }
      } else if (clip.kind === 'audio') {
        const cached = getCachedWaveform(clip.id);
        if (cached) {
          setWaveMap((prev) => (prev[clip.id] ? prev : { ...prev, [clip.id]: cached }));
        } else {
          requestTimelineWaveform(clip, onWavesLoaded);
        }
      }
    }

    for (const clip of clips) {
      if (!visibleClipIds.has(clip.id)) {
        cancelTimelineMediaForClip(clip.id);
      }
    }
  }, [visibleIndexSet, clipLayouts, clips, onThumbsLoaded, onWavesLoaded]);

  useEffect(() => {
    const selectedIndex = selectedClipId
      ? clips.findIndex((clip) => clip.id === selectedClipId)
      : -1;
    if (selectedIndex < 0) return;
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto', behavior: 'smooth' });
  }, [selectedClipId, clips, virtualizer]);

  useEffect(() => {
    virtualizer.measure();
  }, [clipLayouts, virtualizer]);

  const totalDuration = useMemo(
    () => clips.reduce((sum, clip) => sum + effectiveDur(clip), 0),
    [clips],
  );
  const outputDuration = useMemo(
    () => computeTotalDuration(clips, transitions),
    [clips, transitions],
  );
  const contentWidth = timelineContentWidth(totalDuration, pixelsPerSecond);
  const transMap = useMemo(
    () => new Map(transitions.map((t) => [t.afterClipIndex, t])),
    [transitions],
  );

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

  const orphanTransitions = useMemo(
    () => orphanTransitionIndices(
      visibleIndexSet,
      clipLayouts.length,
      (index) => transMap.has(index),
    ),
    [visibleIndexSet, clipLayouts.length, transMap],
  );

  const pinnedDragIndex =
    dragIndex !== null && !visibleIndexSet.has(dragIndex) ? dragIndex : null;

  const renderClipBlock = (layout: VirtualClipLayout, translateX: number) => {
    const { clip, index } = layout;
    const transition = index > 0 ? transMap.get(index) : undefined;
    const showTransition = Boolean(transition);

    return (
      <VirtualClipBlock
        key={clip.id}
        layout={layout}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: layout.width,
          transform: `translateX(${translateX}px)`,
        }}
        selectedClipId={selectedClipId}
        dragIndex={dragIndex}
        thumbs={thumbMap[clip.id]}
        waves={waveMap[clip.id]}
        transition={transition}
        showTransition={showTransition}
        clipCount={clips.length}
        onSelect={onSelect}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
        onEditTransition={setEditingTransition}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onTouchStart={handleTouchStart}
      />
    );
  };

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
        <TimelineRuler
          totalDuration={totalDuration}
          pixelsPerSecond={pixelsPerSecond}
          beatMarkers={beatMarkers}
        />

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
          {virtualItems.map((virtualItem) => {
            const layout = clipLayouts[virtualItem.index];
            if (!layout) return null;

            const showIndicatorBefore =
              dropTargetIndex === layout.index
              && dragIndex !== null
              && dragIndex !== layout.index
              && dragIndex !== layout.index - 1;

            return (
              <Fragment key={layout.clip.id}>
                {showIndicatorBefore && (
                  <div
                    className="timeline-drop-indicator"
                    style={{ left: layout.start }}
                    aria-hidden="true"
                  />
                )}
                {renderClipBlock(layout, virtualItem.start)}
              </Fragment>
            );
          })}

          {pinnedDragIndex !== null && clipLayouts[pinnedDragIndex] && (
            renderClipBlock(clipLayouts[pinnedDragIndex], clipLayouts[pinnedDragIndex].start)
          )}

          {orphanTransitions.map((index) => {
            const transition = transMap.get(index);
            const layout = clipLayouts[index];
            if (!transition || !layout) return null;
            return (
              <button
                key={`orphan-transition-${index}`}
                type="button"
                className={`transition-zone transition-zone--overlay${transition.type !== 'none' ? ' active' : ''}`}
                style={{
                  left: layout.start - 12,
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
            );
          })}

          {dropTargetIndex !== null
            && dragIndex !== null
            && dropTargetIndex < clips.length
            && dragIndex !== dropTargetIndex
            && dragIndex !== dropTargetIndex - 1
            && !virtualItems.some((item) => item.index === dropTargetIndex) && (
              <div
                className="timeline-drop-indicator"
                style={{ left: clipLayouts[dropTargetIndex]?.start ?? 0 }}
                aria-hidden="true"
              />
            )}

          {dropTargetIndex === clips.length
            && dragIndex !== null
            && dragIndex !== clips.length - 1 && (
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
          morphProcessing={
            morphProcessingIndex === editingTransition.afterClipIndex
          }
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
