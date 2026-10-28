import { memo } from 'react';
import { usePlayheadTime } from '../hooks/usePlayheadTime';
import { TIMELINE_GUTTER_PX, timelineContentWidth } from '../utils/timelineLayout';

interface Props {
  totalDuration: number;
  pixelsPerSecond: number;
}

/**
 * The playhead line across every lane. It subscribes to the playhead itself so
 * the (large) Timeline does not re-render on each playback tick.
 */
function TimelinePlayheadImpl({ totalDuration, pixelsPerSecond }: Props) {
  const playheadTime = usePlayheadTime();
  if (playheadTime === null || totalDuration <= 0) return null;

  const x = Math.min(
    timelineContentWidth(totalDuration, pixelsPerSecond),
    Math.max(0, playheadTime * pixelsPerSecond),
  );

  return (
    <div
      className="timeline-playhead"
      style={{ left: TIMELINE_GUTTER_PX + x }}
      data-testid="timeline-playhead"
      aria-hidden="true"
    />
  );
}

export const TimelinePlayhead = memo(TimelinePlayheadImpl);
