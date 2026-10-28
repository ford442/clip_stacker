import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { playbackStore } from '../store/playbackStore';
import {
  buildRulerTicks,
  formatTimelineTime,
  rulerTickInterval,
  timelineContentWidth,
  timelineTimeAtOffset,
} from '../utils/timelineLayout';

interface RulerProps {
  totalDuration: number;
  pixelsPerSecond: number;
  beatMarkers?: { clipId: string; sourceTime: number; leftPx: number }[];
}

export function TimelineRuler({ totalDuration, pixelsPerSecond, beatMarkers = [] }: RulerProps) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const scrubPointerRef = useRef<number | null>(null);

  if (totalDuration <= 0) return null;

  // The playhead is set straight on the store, so the timeline can be scrubbed
  // (and Split used) even when preview playback cannot run.
  const scrubTo = (clientX: number) => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const offset = clientX - ruler.getBoundingClientRect().left;
    playbackStore
      .getState()
      .setPlayheadTime(timelineTimeAtOffset(offset, pixelsPerSecond, totalDuration));
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    scrubPointerRef.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    playbackStore.getState().setScrubbing(true);
    scrubTo(e.clientX);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubPointerRef.current !== e.pointerId) return;
    scrubTo(e.clientX);
  };

  const endScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubPointerRef.current !== e.pointerId) return;
    scrubPointerRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    playbackStore.getState().setScrubbing(false);
  };

  const contentWidth = timelineContentWidth(totalDuration, pixelsPerSecond);
  const interval = rulerTickInterval(totalDuration);
  const ticks = buildRulerTicks(totalDuration, interval);

  return (
    <div
      ref={rulerRef}
      className="timeline-ruler"
      style={{ width: contentWidth }}
      title="Click or drag to move the playhead"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
    >
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
