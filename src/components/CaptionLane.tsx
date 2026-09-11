/**
 * Caption lane: the time-coded caption track drawn under the timeline ruler.
 *
 * Each cue is a chip positioned by its output-timeline seconds. Clicking a
 * chip selects it (the Captions inspector tab edits the selection); dragging
 * either edge trims the cue's in/out point. Double-clicking empty lane space
 * adds a cue there, mirroring {@link SyncMarkerLane}.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { CaptionEntry } from '../types';

export interface CaptionLaneProps {
  captions: CaptionEntry[];
  /** Total output duration in seconds (lane spans 0…duration). */
  duration: number;
  /** Lane width in pixels — matches the timeline's content width. */
  width: number;
  pixelsPerSecond: number;
  selectedCaptionId: string | null;
  onSelect: (id: string | null) => void;
  onResize: (id: string, edge: 'start' | 'end', timeSec: number) => void;
  /** Add a cue at this output time (double-click on empty lane space). */
  onAddAt: (startSec: number) => void;
}

/** Chips narrower than this get no text label — there is nowhere to put it. */
const MIN_LABEL_WIDTH_PX = 28;

interface DragState {
  id: string;
  edge: 'start' | 'end';
}

function CaptionLaneImpl({
  captions,
  duration,
  width,
  pixelsPerSecond,
  selectedCaptionId,
  onSelect,
  onResize,
  onAddAt,
}: CaptionLaneProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  /** Convert a client X coordinate to output-timeline seconds. */
  const timeAtClientX = useCallback(
    (clientX: number): number => {
      const lane = laneRef.current;
      if (!lane || pixelsPerSecond <= 0) return 0;
      const rect = lane.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left) / pixelsPerSecond);
    },
    [pixelsPerSecond],
  );

  const handleEdgePointerDown = (
    event: ReactPointerEvent,
    id: string,
    edge: 'start' | 'end',
  ) => {
    event.stopPropagation();
    event.preventDefault();
    onSelect(id);
    setDrag({ id, edge });
  };

  // Tracked on `window` rather than the chip so the drag survives the pointer
  // leaving the lane (the usual case when dragging an edge to the far end).
  useEffect(() => {
    if (!drag) return;

    const handleMove = (event: PointerEvent) => {
      onResize(drag.id, drag.edge, timeAtClientX(event.clientX));
    };
    const handleUp = () => setDrag(null);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [drag, onResize, timeAtClientX]);

  if (duration <= 0) return null;

  return (
    <div
      ref={laneRef}
      className={`caption-lane${drag ? ' caption-lane--dragging' : ''}`}
      style={{ width }}
      role="group"
      aria-label={`Caption track, ${captions.length} cue${captions.length === 1 ? '' : 's'}`}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget) return;
        onAddAt(timeAtClientX(event.clientX));
      }}
      title="Double-click to add a caption here. Drag a chip's edge to retime it."
    >
      <span className="caption-lane-label" aria-hidden="true">
        CC
      </span>

      {captions.map((caption) => {
        const left = caption.startSec * pixelsPerSecond;
        const chipWidth = Math.max(
          4,
          (caption.endSec - caption.startSec) * pixelsPerSecond,
        );
        const selected = caption.id === selectedCaptionId;
        const singleLine = caption.text.replace(/\s*\n\s*/g, ' ⏎ ');

        return (
          <div
            key={caption.id}
            className={`caption-chip${selected ? ' caption-chip--selected' : ''}`}
            style={{ left, width: chipWidth }}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`Caption from ${caption.startSec.toFixed(2)} to ${caption.endSec.toFixed(2)} seconds: ${singleLine}`}
            title={`${caption.startSec.toFixed(2)}s – ${caption.endSec.toFixed(2)}s\n${caption.text}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelect(caption.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(caption.id);
              }
            }}
          >
            <span
              className="caption-chip-handle caption-chip-handle--start"
              onPointerDown={(event) => handleEdgePointerDown(event, caption.id, 'start')}
              aria-hidden="true"
            />
            {chipWidth >= MIN_LABEL_WIDTH_PX && (
              <span className="caption-chip-text">{singleLine}</span>
            )}
            <span
              className="caption-chip-handle caption-chip-handle--end"
              onPointerDown={(event) => handleEdgePointerDown(event, caption.id, 'end')}
              aria-hidden="true"
            />
          </div>
        );
      })}
    </div>
  );
}

export const CaptionLane = memo(CaptionLaneImpl);
