/**
 * Cubase-style speed / time-remap automation lane under a timeline clip.
 * Click to add keyframes; drag X = output-local time, Y = rate (0.25–4).
 */

import { useCallback, useMemo, useRef, type MouseEvent } from 'react';
import type { Clip, ClipAutomation } from '../types';
import type { Keyframe } from '../utils/keyframes';
import { sortKeyframes, upsertKeyframe, removeKeyframeAt } from '../utils/keyframes';
import {
  clampClipPlaybackRate,
  getClipPlaybackRate,
  MAX_CLIP_PLAYBACK_RATE,
  MIN_CLIP_PLAYBACK_RATE,
} from '../utils/playbackRate';
import {
  remappedClipDuration,
  samplePlaybackRateAt,
  sampleRemapCurve,
} from '../utils/timeRemap';
import { normalizeClipAutomation } from '../utils/clipAutomation';

export interface SpeedAutomationLaneProps {
  clip: Clip;
  /** Clip block width in pixels (matches timeline layout). */
  width: number;
  /** Authoritative output duration from timeline layout (preferred). */
  durationSec?: number;
  height?: number;
  /** Optional playhead in clip-local output seconds. */
  playheadLocal?: number | null;
  onChange: (automation: ClipAutomation | undefined) => void;
}

const LANE_H = 44;

function yToRate(y: number, height: number): number {
  const u = 1 - Math.min(1, Math.max(0, y / height));
  return clampClipPlaybackRate(
    MIN_CLIP_PLAYBACK_RATE + u * (MAX_CLIP_PLAYBACK_RATE - MIN_CLIP_PLAYBACK_RATE),
  );
}

function rateToY(rate: number, height: number): number {
  const r = clampClipPlaybackRate(rate);
  const u =
    (r - MIN_CLIP_PLAYBACK_RATE) / (MAX_CLIP_PLAYBACK_RATE - MIN_CLIP_PLAYBACK_RATE);
  return (1 - Math.min(1, Math.max(0, u))) * height;
}

export function SpeedAutomationLane({
  clip,
  width,
  durationSec,
  height = LANE_H,
  playheadLocal = null,
  onChange,
}: SpeedAutomationLaneProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const duration = Math.max(0.1, durationSec ?? remappedClipDuration(clip));
  const track = useMemo(
    () => sortKeyframes(clip.automation?.playbackRate ?? []),
    [clip.automation?.playbackRate],
  );
  const curve = useMemo(
    () => sampleRemapCurve(clip, Math.max(32, Math.floor(width / 4))),
    [clip, width],
  );

  const commitTrack = useCallback(
    (next: Keyframe[] | undefined) => {
      const automation: ClipAutomation = { ...(clip.automation ?? {}) };
      if (next?.length) automation.playbackRate = next;
      else delete automation.playbackRate;
      onChange(normalizeClipAutomation(automation));
    },
    [clip.automation, onChange],
  );

  const clientToLocal = useCallback(
    (clientX: number, clientY: number) => {
      const el = svgRef.current;
      if (!el) return { t: 0, rate: 1 };
      const rect = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const y = clientY - rect.top;
      return { t: x * duration, rate: yToRate(y, height) };
    },
    [duration, height],
  );

  const handleAdd = (event: MouseEvent) => {
    if ((event.target as Element).closest('.speed-lane-key')) return;
    const { t, rate } = clientToLocal(event.clientX, event.clientY);
    commitTrack(upsertKeyframe(track, t, rate, duration * 0.02));
  };

  const startDrag = (index: number, pointerId: number) => {
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const { t, rate } = clientToLocal(event.clientX, event.clientY);
      const next = [...track];
      next[index] = { ...next[index], t, value: rate };
      commitTrack(sortKeyframes(next));
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const pathD = curve
    .map((p, i) => {
      const x = (p.t / duration) * width;
      const y = rateToY(p.rate, height);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const baselineY = rateToY(1, height);
  const playheadX =
    playheadLocal != null
      ? (Math.min(duration, Math.max(0, playheadLocal)) / duration) * width
      : null;

  return (
    <div className="speed-lane" style={{ width, height }}>
      <svg
        ref={svgRef}
        className="speed-lane-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onClick={handleAdd}
        role="img"
        aria-label="Speed automation lane"
      >
        <line
          x1={0}
          x2={width}
          y1={baselineY}
          y2={baselineY}
          className="speed-lane-baseline"
        />
        <path d={pathD} className="speed-lane-curve" fill="none" />
        {playheadX != null && (
          <line
            x1={playheadX}
            x2={playheadX}
            y1={0}
            y2={height}
            className="speed-lane-playhead"
          />
        )}
        {track.map((key, index) => {
          const x = (key.t / duration) * width;
          const y = rateToY(key.value, height);
          return (
            <circle
              key={`${key.t}-${index}`}
              className="speed-lane-key"
              cx={x}
              cy={y}
              r={5}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                startDrag(index, event.pointerId);
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
                commitTrack(removeKeyframeAt(track, key.t, duration * 0.02));
              }}
            >
              <title>{`t=${key.t.toFixed(2)}s  ${key.value.toFixed(2)}×`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="speed-lane-caption">
        Speed {samplePlaybackRateAt(clip, playheadLocal ?? 0).toFixed(2)}×
        {track.length === 0 ? ' (click to add keyframes)' : ` · ${track.length} keys`}
        <button
          type="button"
          className="speed-lane-seed"
          title="Seed a flat rate curve from the constant speed"
          onClick={(e) => {
            e.stopPropagation();
            const rate = getClipPlaybackRate(clip);
            commitTrack([
              { t: 0, value: rate },
              { t: duration, value: rate },
            ]);
          }}
        >
          Seed
        </button>
      </div>
    </div>
  );
}
