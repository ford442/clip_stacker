import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ClipTransition } from '../types';
import { useEditorCaptions, useEditorClips, useEditorClipGroups, useEditorMasterAudio, useEditorMasterAudioMarkers, useEditorTimelineClips, useEditorTracks, useEditorTextOverlays, useEditorTransitions, useSelectedCaptionId, useSelectedTextOverlayId, editorActions, uiActions } from '../store';
import {
  clampPixelsPerSecond,
  clipPixelWidth,
  DEFAULT_PIXELS_PER_SECOND,
  MIN_CLIP_PIXEL_WIDTH,
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
  MAIN_VIDEO_TRACK_ID,
} from '../utils/trackModel';
import { TrackLaneHeader } from './TrackLaneHeader';
import type { VirtualClipLayout } from './timelineClipTypes';
import { TransitionEditor } from './TransitionEditor';
import { VirtualClipBlock } from './VirtualClipBlock';
import { MasterAudioTrack } from './MasterAudioTrack';
import { clipHasRateAutomation } from '../utils/timeRemap';
import SyncMarkerLane from './SyncMarkerLane';
import { CaptionLane } from './CaptionLane';
import MarkerConnectionCanvas from './MarkerConnectionCanvas';
import { SyncDragProvider } from '../context/SyncDragContext';
import { useTimelineDragDrop } from '../hooks/useTimelineDragDrop';
import { TimelineHeader } from './TimelineHeader';
import { TimelineLaneRows } from './TimelineLaneRows';
import { TimelineRuler } from './TimelineRuler';
import { TimelineSelectionScroll } from './TimelineSelectionScroll';

interface Props {
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onReorder: (fromIndex: number, insertBefore: number) => void;
  /** Drop onto a lane; `snapThresholdSec` is the magnet radius at the current zoom. */
  onMoveToTrack: (
    clipId: string,
    targetTrackId: string,
    startTime: number,
    snapThresholdSec?: number,
  ) => void;
  onTransitionUpdate: (updated: ClipTransition) => void;
  onDelete: (id: string) => void;
  /** Retime one edge of a caption cue (drag on the CC lane). */
  onCaptionResize: (id: string, edge: 'start' | 'end', timeSec: number) => void;
  /** Add a caption cue at an output time (double-click on the CC lane). */
  onCaptionAdd: (startSec: number) => void;
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

// ─── Main Timeline ───────────────────────────────────────────────────────────

function TimelineImpl({
  onMoveUp,
  onMoveDown,
  onReorder,
  onMoveToTrack,
  onTransitionUpdate,
  onDelete,
  onCaptionResize,
  onCaptionAdd,
  morphProcessingIndex = null,
}: Props) {
  const clips = useEditorTimelineClips();
  const allClips = useEditorClips();
  const clipGroups = useEditorClipGroups();
  const tracks = useEditorTracks();
  const masterAudio = useEditorMasterAudio();
  const transitions = useEditorTransitions();
  const masterAudioMarkers = useEditorMasterAudioMarkers();
  const captions = useEditorCaptions();
  const textOverlays = useEditorTextOverlays();
  const selectedCaptionId = useSelectedCaptionId();
  const selectedTextOverlayId = useSelectedTextOverlayId();
  const [thumbMap, setThumbMap] = useState<Record<string, string[]>>({});
  const [waveMap, setWaveMap] = useState<Record<string, Float32Array>>({});
  const [editingTransition, setEditingTransition] = useState<ClipTransition | null>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const mainTrackLocked = useMemo(
    () => tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)?.locked ?? false,
    [tracks],
  );

  const {
    dragIndex,
    dropTargetIndex,
    setDropTargetIndex,
    dragClipId,
    setDragClipId,
    dropTargetTrackId,
    trackRef,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    handleTouchStart,
    handleTouchMoveOnTrack,
    handleTouchEnd,
  } = useTimelineDragDrop({
    clipLayouts,
    tracks,
    allClips,
    scrollRef,
    pixelsPerSecond,
    mainTrackLocked,
    onReorder,
    onMoveToTrack,
  });

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

  const adjustZoom = (factor: number) => {
    setPixelsPerSecond((current) => clampPixelsPerSecond(current * factor));
  };

  const scrollTimeline = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

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
        locked={mainTrackLocked}
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
    <SyncDragProvider>
      <section className="panel timeline-panel">
        <TimelineSelectionScroll virtualizerRef={virtualizerRef} />
      <TimelineHeader
        outputDuration={outputDuration}
        totalDuration={totalDuration}
        pixelsPerSecond={pixelsPerSecond}
        setPixelsPerSecond={setPixelsPerSecond}
        adjustZoom={adjustZoom}
        scrollTimeline={scrollTimeline}
        scrollRef={scrollRef}
        hasOverlayClips={hasOverlayClips}
      />

      <div
        className="timeline-scroll-container"
        ref={scrollRef}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{ position: 'relative' }} // Need relative positioning for MarkerConnectionCanvas
      >
        <MarkerConnectionCanvas 
          layouts={clipLayouts}
          masterMarkers={masterAudioMarkers}
          pixelsPerSecond={pixelsPerSecond}
          masterAudioLaneY={24} // Based on TimelineRuler height usually
          getTrackY={(clipId) => {
            // Rough estimation for prototype, assumes MAIN_VIDEO_TRACK_ID
            return 48; // Space under ruler + audio lane
          }}
        />

        <TimelineRuler
          totalDuration={totalDuration}
          pixelsPerSecond={pixelsPerSecond}
          beatMarkers={beatMarkers}
        />
        
        <SyncMarkerLane
          markers={masterAudioMarkers}
          duration={totalDuration}
          width={contentWidth}
          laneType="audio"
          clipId={null}
          onUpdateMarkers={(markers) => editorActions.setMasterAudioMarkers(markers)}
        />

        <CaptionLane
          captions={captions}
          duration={totalDuration}
          width={contentWidth}
          pixelsPerSecond={pixelsPerSecond}
          selectedCaptionId={selectedCaptionId}
          onSelect={uiActions.setSelectedCaptionId}
          onResize={onCaptionResize}
          onAddAt={onCaptionAdd}
        />

        <div
          className={`timeline-track-row timeline-track-row--main${
            dropTargetTrackId === MAIN_VIDEO_TRACK_ID ? ' timeline-track-row--drop-target' : ''
          }`}
          data-track-id={MAIN_VIDEO_TRACK_ID}
        >
          <TrackLaneHeader trackId={MAIN_VIDEO_TRACK_ID} showRemove={false} />
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
        </div>

        <TimelineLaneRows
          tracks={tracks}
          trackLayouts={trackLayouts}
          textOverlays={textOverlays}
          selectedTextOverlayId={selectedTextOverlayId}
          contentWidth={contentWidth}
          pixelsPerSecond={pixelsPerSecond}
          dropTargetTrackId={dropTargetTrackId}
          dragClipId={dragClipId}
          setDragClipId={setDragClipId}
          thumbMap={thumbMap}
          waveMap={waveMap}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onDelete={onDelete}
          handleDragStart={handleDragStart}
          handleDragEnd={handleDragEnd}
        />
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
    </SyncDragProvider>
  );
}

/**
 * Subscribes to timeline clips and transitions via the editor store (#144).
 * Selection is handled per-row in {@link VirtualClipBlock} so changing the
 * selected clip does not re-render the whole timeline.
 */
export const Timeline = memo(TimelineImpl);
