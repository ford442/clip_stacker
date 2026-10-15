import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Clip, Track } from '../types';
import { acceptsClipKind, MAIN_VIDEO_TRACK_ID } from '../utils/trackModel';
import { snapThresholdForZoom } from '../utils/timelineSnap';
import type { VirtualClipLayout } from '../components/timelineClipTypes';

interface TimelineDragDropOptions {
  /** Main-lane clip layouts (drag indices refer to these). */
  clipLayouts: VirtualClipLayout[];
  tracks: Track[];
  allClips: Clip[];
  /** The timeline's horizontal scroll container. */
  scrollRef: RefObject<HTMLDivElement>;
  pixelsPerSecond: number;
  mainTrackLocked: boolean;
  onReorder: (fromIndex: number, insertBefore: number) => void;
  onMoveToTrack: (
    clipId: string,
    targetTrackId: string,
    startTime: number,
    snapThresholdSec?: number,
  ) => void;
}

/**
 * The timeline's drag-and-drop: HTML5 drag on desktop and long-press touch
 * drag on mobile. A drop on the main lane reorders it; a drop on another lane
 * moves the clip there. Returns the drag state and the handlers `Timeline`
 * wires onto its lanes (`trackRef` is the main lane's clip strip).
 */
export function useTimelineDragDrop({
  clipLayouts,
  tracks,
  allClips,
  scrollRef,
  pixelsPerSecond,
  mainTrackLocked,
  onReorder,
  onMoveToTrack,
}: TimelineDragDropOptions) {
  // ── Drag-and-drop state ──────────────────────────────────────────────────
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [dragClipId, setDragClipId] = useState<string | null>(null);
  const [dropTargetTrackId, setDropTargetTrackId] = useState<string | null>(null);
  const touchDragRef = useRef<number | null>(null);
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  /**
   * Whether the dragged clip may land on `trackId` — a locked lane and a lane of
   * the wrong kind (a video clip on an audio lane) both refuse it. Used to gate
   * the drop highlight so the timeline never invites an edit the store rejects.
   */
  const canDropOn = useCallback(
    (trackId: string | null): boolean => {
      if (!trackId) return false;
      const track = tracks.find((t) => t.id === trackId);
      if (!track || track.locked) return false;
      const clip = dragClipId ? allClips.find((c) => c.id === dragClipId) : null;
      return clip ? acceptsClipKind(track, clip.kind) : true;
    },
    [tracks, allClips, dragClipId],
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
    // Measure against the lane's clip strip, not the row: the row also contains
    // the fixed-width lane header, which would offset every dropped start time.
    const strip = row.querySelector<HTMLElement>('.timeline-track') ?? row;
    const rect = strip.getBoundingClientRect();
    const x = clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
    const startTime = Math.max(0, x / pixelsPerSecond);
    return { trackId: targetTrackId, startTime };
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
    setDropTargetTrackId(drop && canDropOn(drop.trackId) ? drop.trackId : null);
    setDropTargetIndex(calcInsertIndex(e.clientX));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndex ?? Number(e.dataTransfer.getData('text/plain'));
    const drop = calcDropOnTrack(e.clientX, e.clientY);
    const insertBefore = calcInsertIndex(e.clientX);

    if (drop && dragClipId && drop.trackId !== MAIN_VIDEO_TRACK_ID) {
      if (canDropOn(drop.trackId)) {
        onMoveToTrack(
          dragClipId,
          drop.trackId,
          drop.startTime,
          snapThresholdForZoom(pixelsPerSecond),
        );
      }
    } else if (
      !mainTrackLocked
      && from !== insertBefore
      && from !== insertBefore - 1
    ) {
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

  return {
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
  };
}
