import { memo, useCallback, useRef, type CSSProperties, type DragEvent, type TouchEvent } from 'react';
import type { ClipAutomation, ClipTransition } from '../types';
import { editorActions, useIsClipSelected } from '../store';
import { WaveformCanvas } from './WaveformCanvas';
import { SpeedAutomationLane } from './SpeedAutomationLane';
import type { VirtualClipLayout } from './timelineClipTypes';
import { normalizeClipAutomation } from '../utils/clipAutomation';
import { clipHasRateAutomation } from '../utils/timeRemap';

const TRANSITION_COLORS: Record<string, string> = {
  none: 'var(--border)',
  dissolve: '#7c4dff',
  motion: '#f06292',
  morph: '#26c6da',
};

/** Horizontal distance (px) required to trigger a swipe-swap. */
const SWIPE_THRESHOLD_PX = 48;
/** Max vertical movement (px) allowed for a gesture to still count as horizontal swipe. */
const SWIPE_VERTICAL_TOLERANCE_PX = 36;
/** Hold duration (ms) before starting a drag-reorder (long-press). */
const LONG_PRESS_MS = 420;

interface Props {
  layout: VirtualClipLayout;
  style: CSSProperties;
  /** Whether this row's clip is the one currently being dragged (see `useIsClipSelected`). */
  isDragging: boolean;
  thumbs?: string[];
  waves?: Float32Array;
  transition?: ClipTransition;
  showTransition: boolean;
  clipCount: number;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDelete: (id: string) => void;
  onEditTransition: (transition: ClipTransition) => void;
  onDragStart: (e: DragEvent, index: number) => void;
  onDragEnd: () => void;
  /** Called on long-press to begin full drag-reorder. */
  onTouchStart: (index: number) => void;
  /** When true, show the Cubase-style speed remapping lane under the clip. */
  showSpeedLane?: boolean;
}

function VirtualClipBlockImpl({
  layout,
  style,
  isDragging,
  thumbs,
  waves,
  transition,
  showTransition,
  clipCount,
  onMoveUp,
  onMoveDown,
  onDelete,
  onEditTransition,
  onDragStart,
  onDragEnd,
  onTouchStart,
  showSpeedLane = false,
}: Props) {
  const { clip, index, duration } = layout;
  const isSelected = useIsClipSelected(clip.id);
  const isLoadingThumbs = clip.kind === 'video' && thumbs === undefined;
  const isLoadingWave = clip.kind === 'audio' && waves === undefined;
  const layerIndex = clip.layerIndex ?? 0;
  const isOverlay = layerIndex > 0;
  const speedOpen = showSpeedLane && isSelected;

  const handleSpeedChange = useCallback(
    (automation: ClipAutomation | undefined) => {
      editorActions.pushHistoryDebounced(`speed-lane:${clip.id}`);
      const next = normalizeClipAutomation(automation);
      editorActions.setClips((prev) =>
        prev.map((c) => {
          if (c.id !== clip.id) return c;
          if (!next) {
            const { automation: _removed, ...rest } = c;
            return rest;
          }
          return { ...c, automation: next };
        }),
      );
    },
    [clip.id],
  );

  // Touch / swipe-swap state (kept in refs so the memoized component stays pure).
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);
  const didSwipeRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
      didLongPressRef.current = false;
      didSwipeRef.current = false;
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        didLongPressRef.current = true;
        onTouchStart(index); // start the parent drag-reorder
        // Optional haptic feedback when available
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate(12);
          } catch {
            /* ignore */
          }
        }
      }, LONG_PRESS_MS);
    },
    [clearLongPress, index, onTouchStart],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!touchStartRef.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - touchStartRef.current.x;
      const dy = t.clientY - touchStartRef.current.y;
      // Cancel long-press as soon as the finger moves meaningfully.
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        clearLongPress();
      }
    },
    [clearLongPress],
  );

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      clearLongPress();
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start || didLongPressRef.current) {
        // Long-press already handed control to the parent drag system.
        return;
      }
      // Use the last known touch (or changedTouches[0]) for end position.
      const endTouch = e.changedTouches[0];
      if (!endTouch) return;
      const dx = endTouch.clientX - start.x;
      const dy = endTouch.clientY - start.y;
      const elapsed = Date.now() - start.time;

      // Quick horizontal swipe → adjacent swap.
      if (
        elapsed < 600 &&
        Math.abs(dx) >= SWIPE_THRESHOLD_PX &&
        Math.abs(dy) <= SWIPE_VERTICAL_TOLERANCE_PX
      ) {
        didSwipeRef.current = true;
        e.preventDefault(); // stop synthetic click
        if (dx < 0) {
          // Swipe left → move clip left (toward earlier position)
          if (index > 0) onMoveUp(index);
        } else {
          // Swipe right → move clip right (toward later position)
          if (index < clipCount - 1) onMoveDown(index);
        }
      }
    },
    [clearLongPress, clipCount, index, onMoveDown, onMoveUp],
  );

  const handleTouchCancel = useCallback(() => {
    clearLongPress();
    touchStartRef.current = null;
    didLongPressRef.current = false;
    didSwipeRef.current = false;
  }, [clearLongPress]);

  const handleClick = useCallback(() => {
    // Suppress the click that follows a swipe or long-press so we don't
    // accidentally change selection right after a reorder gesture.
    if (didSwipeRef.current || didLongPressRef.current) {
      didSwipeRef.current = false;
      didLongPressRef.current = false;
      return;
    }
    editorActions.setSelectedClipId(clip.id);
  }, [clip.id]);

  return (
    <>
      {showTransition && transition && (
        <button
          type="button"
          className={`transition-zone transition-zone--overlay${transition.type !== 'none' ? ' active' : ''}`}
          style={{
            left: layout.start - 12,
            '--tz-color': TRANSITION_COLORS[transition.type],
          } as CSSProperties}
          onClick={() => onEditTransition(transition)}
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
        className={`timeline-clip-wrapper${isDragging ? ' is-dragging' : ''}`}
        style={style}
        data-clip-index={index}
        draggable
        onDragStart={(e) => onDragStart(e, index)}
        onDragEnd={onDragEnd}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        <div
          className={`timeline-clip${clip.kind === 'audio' ? ' timeline-clip--audio' : ''}${
            isSelected ? ' selected' : ''
          }${isOverlay ? ' timeline-clip--pip' : ''}`}
          onClick={handleClick}
          title={
            isOverlay
              ? `${clip.title}\nPicture-in-Picture overlay (layer ${layerIndex}) — plays from the start of the output, not at its position on this row.\n\nSwipe left/right to swap with neighbor, or long-press then drag to reorder.`
              : `${clip.title}\n\nSwipe left/right to swap with neighbor, or long-press then drag to reorder.`
          }
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
              aria-label="Drag handle — long-press then drag to reorder, or swipe left/right to swap"
              title="Long-press + drag to reorder · swipe ←/→ to swap"
            >
              ⠿
            </span>

            {isOverlay && (
              <span
                className="timeline-clip-badge"
                title={`Picture-in-Picture overlay, layer ${layerIndex}. Overlay clips always play from the start of the output, independent of where they sit on this track.`}
              >
                PiP · L{layerIndex}
              </span>
            )}

            {clipHasRateAutomation(clip) && (
              <span className="timeline-clip-badge timeline-clip-badge--speed" title="Speed remapping automation">
                Speed
              </span>
            )}

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
                disabled={index === clipCount - 1}
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
        {speedOpen && (
          <div
            className="timeline-speed-lane-wrap"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <SpeedAutomationLane
              clip={clip}
              width={layout.width}
              durationSec={duration}
              onChange={handleSpeedChange}
            />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Memoized so that selecting a different clip (or editing one clip's data)
 * only re-renders the affected row(s), not every row in the timeline —
 * critical once timelines have hundreds of clips (#150).
 */
export const VirtualClipBlock = memo(VirtualClipBlockImpl);
