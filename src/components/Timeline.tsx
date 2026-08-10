import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ClipTransition } from '../types';
import { useEditorClips, useEditorClipGroups, useEditorMasterAudio, useEditorTimelineClips, useEditorTracks, useEditorTransitions, useSelectedClipId } from '../store';
import { editorStore } from '../store/editorStore';
import { getEffectiveTimelineClips } from '../utils/timelineClips';
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
import {
  buildTrackClipLayouts,
  computeTracksDuration,
  DEFAULT_TRACK_HEIGHT,
  MAIN_VIDEO_TRACK_ID,
} from '../utils/trackModel';
import type { VirtualClipLayout } from './timelineClipTypes';
import { TransitionEditor } from './TransitionEditor';
import { VirtualClipBlock } from './VirtualClipBlock';
import { MasterAudioTrack } from './MasterAudioTrack';
import { clipHasRateAutomation } from '../utils/timeRemap';

interface Props {
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onReorder: (fromIndex: number, insertBefore: number) => void;
  onMoveToTrack: (clipId: string, targetTrackId: string, startTime: number) => void;
  onTransitionUpdate: (updated: ClipTransition) => void;
  onDelete: (id: string) => void;
  morphProcessingIndex?: number | null;
}

function effectiveDur(clip: { trimStart: number; trimEnd: number; duration: number }): number {
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

/** Scrolls the virtualizer when selection changes without re-rendering the timeline track. */
function TimelineSelectionScroll({
  virtualizerRef,
}: {
  virtualizerRef: RefObject<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>;
}) {
  const selectedClipId = useSelectedClipId();
  const scrolledForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedClipId) {
      scrolledForRef.current = null;
      return;
    }
    if (scrolledForRef.current === selectedClipId) return;
    scrolledForRef.current = selectedClipId;

    const { tracks, clips, clipGroups } = editorStore.getState();
    const timelineClips = getEffectiveTimelineClips(tracks, clips, clipGroups);
    const selectedIndex = timelineClips.findIndex((clip) => clip.id === selectedClipId);
    if (selectedIndex < 0) return;
    virtualizerRef.current?.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedClipId, virtualizerRef]);

  return null;
}

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

function TimelineImpl({
  onMoveUp,
  onMoveDown,
  onReorder,
  onMoveToTrack,
  onTransitionUpdate,
  onDelete,
  morphProcessingIndex = null,
}: Props) {
  const clips = useEditorTimelineClips();
  const allClips = useEditorClips();
  const clipGroups = useEditorClipGroups();
  const tracks = useEditorTracks();
  const masterAudio = useEditorMasterAudio();
  const transitions = useEditorTransitions();
  const [thumbMap, setThumbMap] = useState<Record<string, string[]>>({});
  const [waveMap, setWaveMap] = useState<Record<string, Float32Array>>({});
  const [editingTransition, setEditingTransition] = useState<ClipTransition | null>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Drag-and-drop state ──────────────────────────────────────────────────
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [dragClipId, setDragClipId] = useState<string | null>(null);
  const [dropTargetTrackId, setDropTargetTrackId] = useState<string | null>(null);
  const touchDragRef = useRef<number | null>(null);
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const trackLayouts = useMemo(
    () => buildTrackClipLayouts(tracks, allClips, clipGroups, pixelsPerSecond),
    [tracks, allClips, clipGroups, pixelsPerSecond],
  );

  const clipLayouts = useMemo<VirtualClipLayout[]>(() => {
    const mainLayouts = trackLayouts.get(MAIN_VIDEO_TRACK_ID) ?? [];
    return mainLayouts.map((layout, index) => ({
      clip: layout.clip,
      index,
      duration: layout.duration,
      width: layout.width,
      start: layout.left,
    }));
  }, [trackLayouts]);

  const beatMarkers = useMemo(() => buildBeatMarkerLayouts(clipLayouts), [clipLayouts]);

  const estimateSize = useCallback(
    (index: number) => clipLayouts[index]?.width ?? MIN_CLIP_PIXEL_WIDTH,
    [clipLayouts],
  );
  const getItemKey = useCallback(
    (index: number) => clipLayouts[index]?.clip.id ?? index,
    [clipLayouts],
  );

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: clipLayouts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const virtualItems = virtualizer.getVirtualItems();

  const virtualIndexKey = virtualItems.map((item) => item.index).join(',');
  const visibleIndexSet = useMemo(() => {
    const indices = new Set(virtualItems.map((item) => item.index));
    if (dragIndex !== null) indices.add(dragIndex);
    return indices;
  }, [virtualIndexKey, dragIndex]);

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
        if (clipHasRateAutomation(clip)) {
          const cachedWave = getCachedWaveform(clip.id);
          if (cachedWave) {
            setWaveMap((prev) => (prev[clip.id] ? prev : { ...prev, [clip.id]: cachedWave }));
          } else {
            requestTimelineWaveform(clip, onWavesLoaded, { allowVideo: true });
          }
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
  }, [virtualIndexKey, clipLayouts, clips, onThumbsLoaded, onWavesLoaded]);

  useEffect(() => {
    virtualizerRef.current.measure();
  }, [clipLayouts]);

  const totalDuration = useMemo(
    () => computeTracksDuration(tracks, allClips, transitions, clipGroups),
    [tracks, allClips, transitions, clipGroups],
  );
  const outputDuration = useMemo(
    () => computeTotalDuration(clips, transitions),
    [clips, transitions],
  );
  const hasOverlayClips = useMemo(
    () => allClips.some((clip) => (clip.layerIndex ?? 0) > 0),
    [allClips],
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

  const calcDropOnTrack = (clientX: number, clientY: number): { trackId: string; startTime: number } | null => {
    const rows = scrollRef.current?.querySelectorAll<HTMLElement>('.timeline-track-row');
    if (!rows?.length) return null;

    let targetTrackId: string | null = null;
    for (const row of Array.from(rows)) {
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        targetTrackId = row.dataset.trackId ?? null;
        break;
      }
    }
    if (!targetTrackId) return null;

    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-track-id="${targetTrackId}"]`);
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    const x = clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
    const startTime = Math.max(0, x / pixelsPerSecond);
    return { trackId: targetTrackId, startTime };
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
  // useCallback here keeps these stable across renders so the memoized
  // VirtualClipBlock rows (which receive them as props) don't all re-render
  // just because Timeline re-rendered for an unrelated reason.
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    const layout = clipLayouts[index];
    if (layout) setDragClipId(layout.clip.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, [clipLayouts]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const drop = calcDropOnTrack(e.clientX, e.clientY);
    if (drop) {
      setDropTargetTrackId(drop.trackId);
    }
    setDropTargetIndex(calcInsertIndex(e.clientX));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndex ?? Number(e.dataTransfer.getData('text/plain'));
    const drop = calcDropOnTrack(e.clientX, e.clientY);
    const insertBefore = calcInsertIndex(e.clientX);

    if (drop && dragClipId && drop.trackId !== MAIN_VIDEO_TRACK_ID) {
      onMoveToTrack(dragClipId, drop.trackId, drop.startTime);
    } else if (from !== insertBefore && from !== insertBefore - 1) {
      onReorder(from, insertBefore);
    }

    setDragIndex(null);
    setDragClipId(null);
    setDropTargetIndex(null);
    setDropTargetTrackId(null);
  };

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragClipId(null);
    setDropTargetIndex(null);
    setDropTargetTrackId(null);
  }, []);

  // ── Touch handlers (mobile) ──────────────────────────────────────────────
  // Long-press is now initiated inside VirtualClipBlock; this only receives
  // the index once the long-press timer fires so full free-reorder can start.
  const handleTouchStart = useCallback((index: number) => {
    touchDragRef.current = index;
    lastTouchPos.current = null;
    setDragIndex(index);
  }, []);

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
        isDragging={dragIndex === index}
        thumbs={thumbMap[clip.id]}
        waves={waveMap[clip.id]}
        transition={transition}
        showTransition={showTransition}
        clipCount={clips.length}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
        onEditTransition={setEditingTransition}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onTouchStart={handleTouchStart}
        showSpeedLane
        showVideoWaveform={clipHasRateAutomation(clip)}
      />
    );
  };

  if (tracks.every((t) => t.items.length === 0) && clips.length === 0) {
    return (
      <section className="panel timeline-panel">
        <h2>Timeline</h2>
        <p className="muted">No clips added yet.</p>
      </section>
    );
  }

  return (
    <section className="panel timeline-panel">
      <TimelineSelectionScroll virtualizerRef={virtualizerRef} />
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
      <p className="timeline-hint muted">
        Swipe left/right on a clip to swap with its neighbor. Long-press then drag to reorder freely
        or move between tracks. Shift + scroll wheel zooms.
      </p>
      {hasOverlayClips && (
        <p className="timeline-hint timeline-hint--pip muted">
          🖼 Clips marked <strong>PiP</strong> are Picture-in-Picture overlays — they composite on
          top of the base video starting at the beginning of the output, regardless of where they
          sit on their track.
        </p>
      )}

      <div
        className="timeline-scroll-container"
        ref={scrollRef}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
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
                {renderClipBlock(layout, layout.start)}
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

        {tracks.filter((t) => t.id !== MAIN_VIDEO_TRACK_ID).map((track) => {
          const rowLayouts = trackLayouts.get(track.id) ?? [];
          const rowHeight = track.height ?? DEFAULT_TRACK_HEIGHT;
          return (
            <div
              key={track.id}
              className={`timeline-track-row${dropTargetTrackId === track.id ? ' timeline-track-row--drop-target' : ''}`}
              data-track-id={track.id}
            >
              <div
                className="timeline-track-label"
                title={
                  track.kind === 'video'
                    ? `${track.label ?? track.kind} — Picture-in-Picture overlay track. Clips here composite on top of Video 1 starting at output time 0, independent of their position on this row.`
                    : track.label
                }
              >
                {track.label ?? track.kind}
              </div>
              <div className="timeline-track timeline-track--overlay" style={{ width: contentWidth, height: rowHeight }}>
                {rowLayouts.map((layout) => (
                  <VirtualClipBlock
                    key={layout.clip.id}
                    layout={{
                      clip: layout.clip,
                      index: layout.itemIndex,
                      duration: layout.duration,
                      width: layout.width,
                      start: layout.left,
                    }}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: layout.width,
                      transform: `translateX(${layout.left}px)`,
                    }}
                    isDragging={dragClipId === layout.clip.id}
                    thumbs={thumbMap[layout.clip.id]}
                    waves={waveMap[layout.clip.id]}
                    clipCount={rowLayouts.length}
                    showTransition={false}
                    onMoveUp={onMoveUp}
                    onMoveDown={onMoveDown}
                    onDelete={onDelete}
                    onEditTransition={() => {}}
                    onDragStart={(e, clipIndex) => {
                      setDragClipId(layout.clip.id);
                      handleDragStart(e, clipIndex);
                    }}
                    onDragEnd={handleDragEnd}
                    onTouchStart={() => setDragClipId(layout.clip.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <MasterAudioTrack
          masterAudio={masterAudio}
          totalDuration={totalDuration}
          pixelsPerSecond={pixelsPerSecond}
          contentWidth={contentWidth}
        />
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

/**
 * Subscribes to timeline clips and transitions via the editor store (#144).
 * Selection is handled per-row in {@link VirtualClipBlock} so changing the
 * selected clip does not re-render the whole timeline.
 */
export const Timeline = memo(TimelineImpl);
