import {
  buildRulerTicks,
  formatTimelineTime,
  rulerTickInterval,
  timelineContentWidth,
} from '../utils/timelineLayout';

interface RulerProps {
  totalDuration: number;
  pixelsPerSecond: number;
  beatMarkers?: { clipId: string; sourceTime: number; leftPx: number }[];
}

export function TimelineRuler({ totalDuration, pixelsPerSecond, beatMarkers = [] }: RulerProps) {
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
