/**
 * Compact speed automation curve overlay drawn on top of timeline clips.
 */

import { useMemo } from 'react';
import type { Clip } from '../types';
import {
  clampClipPlaybackRate,
  MAX_CLIP_PLAYBACK_RATE,
  MIN_CLIP_PLAYBACK_RATE,
} from '../utils/playbackRate';
import { remappedClipDuration, sampleRemapCurve } from '../utils/timeRemap';

interface Props {
  clip: Clip;
  width: number;
  height?: number;
  durationSec?: number;
}

function rateToY(rate: number, height: number): number {
  const r = clampClipPlaybackRate(rate);
  const u =
    (r - MIN_CLIP_PLAYBACK_RATE) / (MAX_CLIP_PLAYBACK_RATE - MIN_CLIP_PLAYBACK_RATE);
  return (1 - Math.min(1, Math.max(0, u))) * height;
}

export function SpeedCurveOverlay({
  clip,
  width,
  height = 28,
  durationSec,
}: Props) {
  const duration = Math.max(0.1, durationSec ?? remappedClipDuration(clip));
  const curve = useMemo(
    () => sampleRemapCurve(clip, Math.max(24, Math.floor(width / 6))),
    [clip, width],
  );

  const pathD = curve
    .map((p, i) => {
      const x = (p.t / duration) * width;
      const y = rateToY(p.rate, height);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const baselineY = rateToY(1, height);

  return (
    <svg
      className="speed-curve-overlay"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <line
        x1={0}
        x2={width}
        y1={baselineY}
        y2={baselineY}
        className="speed-curve-overlay-baseline"
      />
      <path d={pathD} className="speed-curve-overlay-path" fill="none" />
    </svg>
  );
}
