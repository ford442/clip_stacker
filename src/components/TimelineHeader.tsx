import type { Dispatch, RefObject, SetStateAction } from 'react';
import { editorActions } from '../store';
import {
  clampPixelsPerSecond,
  formatTimelineTime,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
} from '../utils/timelineLayout';
import { TimelineTools } from './TimelineTools';

interface TimelineHeaderProps {
  outputDuration: number;
  totalDuration: number;
  pixelsPerSecond: number;
  setPixelsPerSecond: Dispatch<SetStateAction<number>>;
  adjustZoom: (factor: number) => void;
  scrollTimeline: (delta: number) => void;
  scrollRef: RefObject<HTMLDivElement>;
  hasOverlayClips: boolean;
}

/** The timeline's title row (duration, zoom / scroll, edit tools, add-track) and hints. */
export function TimelineHeader({
  outputDuration,
  totalDuration,
  pixelsPerSecond,
  setPixelsPerSecond,
  adjustZoom,
  scrollTimeline,
  scrollRef,
  hasOverlayClips,
}: TimelineHeaderProps) {
  return (
    <>
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
        <TimelineTools />
        <div className="timeline-add-track-controls" role="group" aria-label="Add track">
          <button
            type="button"
            className="btn-secondary timeline-add-track-btn"
            onClick={() => editorActions.addTrack('video')}
            title="Add a video lane above the existing ones (composites on top)"
          >
            + Video track
          </button>
          <button
            type="button"
            className="btn-secondary timeline-add-track-btn"
            onClick={() => editorActions.addTrack('audio')}
            title="Add an audio lane for a concurrent music / SFX bed"
          >
            + Audio track
          </button>
          <button
            type="button"
            className="btn-secondary timeline-add-track-btn"
            onClick={() => editorActions.addTrack('text')}
            title="Add a titles lane — new text overlays land here and follow its mute / lock"
          >
            + Titles track
          </button>
        </div>
      </div>
      <p className="timeline-hint muted">
        Swipe left/right on a clip to swap with its neighbor. Long-press then drag to reorder freely
        or move between tracks. Shift + scroll wheel zooms.
      </p>
      {hasOverlayClips && (
        <p className="timeline-hint timeline-hint--pip muted">
          🖼 Clips marked <strong>PiP</strong> sit on a video lane above <strong>Video 1</strong>.
          Stacking order is lane order — the higher the lane, the closer to the front — and each
          clip appears at its own position on the lane, not at the start of the output.
        </p>
      )}
    </>
  );
}
