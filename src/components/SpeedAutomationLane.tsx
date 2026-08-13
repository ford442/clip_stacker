/**
 * Cubase-style speed / time-remap automation lane under a timeline clip.
 * Click to add keyframes; drag X = output-local time, Y = rate (0.25–4).
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { Clip, ClipAutomation, SyncMarker } from '../types';
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
  sourceTimeAtOutputLocal,
} from '../utils/timeRemap';
import { normalizeClipAutomation } from '../utils/clipAutomation';
import {
  collectSpeedKeyframeSnapTimes,
  formatPlaybackRateAria,
  formatPlaybackRateLabel,
  getLastSeedRate,
  setLastSeedRate,
  snapOutputLocalToMarkers,
  speedLaneRateTicks,
  SPEED_KEYFRAME_HIT_PX,
  SPEED_KEYFRAME_RATE_NUDGE,
  SPEED_KEYFRAME_RATE_NUDGE_FINE,
  SPEED_KEYFRAME_TIME_NUDGE_FINE_SEC,
  SPEED_KEYFRAME_TIME_NUDGE_SEC,
} from '../utils/speedLane';

export interface SpeedAutomationLaneProps {
  clip: Clip;
  /** Clip block width in pixels (matches timeline layout). */
  width: number;
  /** Authoritative output duration from timeline layout (preferred). */
  durationSec?: number;
  height?: number;
  /** Optional playhead in clip-local output seconds. */
  playheadLocal?: number | null;
  /** Clip start on the output timeline (for master-marker snap). */
  clipOutputStart?: number;
  /** Master-audio sync markers (output-timeline seconds). */
  masterMarkers?: SyncMarker[];
  onChange: (automation: ClipAutomation | undefined) => void;
}

const LANE_H = 56;
const SCALE_GUTTER = 30;

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

function keyframeTitle(key: Keyframe): string {
  return `Keyframe at ${key.t.toFixed(2)}s, rate ${formatPlaybackRateLabel(key.value)}. Drag to move. Double-click or Enter to commit. Delete or Backspace to remove. Hold Alt while dragging to snap to beats or sync markers. Arrow keys nudge time (left/right) and rate (up/down); Shift for fine steps.`;
}

export function SpeedAutomationLane({
  clip,
  width,
  durationSec,
  height = LANE_H,
  playheadLocal = null,
  clipOutputStart = 0,
  masterMarkers = [],
  onChange,
}: SpeedAutomationLaneProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  const announceRef = useRef<HTMLDivElement>(null);
  const gradientId = useId().replace(/:/g, '');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [dragPreview, setDragPreview] = useState<{ index: number; t: number; value: number } | null>(
    null,
  );
  const [liveStatus, setLiveStatus] = useState('');

  const duration = Math.max(0.1, durationSec ?? remappedClipDuration(clip));
  const graphWidth = Math.max(1, width - SCALE_GUTTER);
  const track = useMemo(
    () => sortKeyframes(clip.automation?.playbackRate ?? []),
    [clip.automation?.playbackRate],
  );
  const snapTimes = useMemo(
    () => collectSpeedKeyframeSnapTimes(clip, clipOutputStart, masterMarkers),
    [clip, clipOutputStart, masterMarkers],
  );
  const curve = useMemo(
    () => sampleRemapCurve(clip, Math.max(32, Math.floor(graphWidth / 4))),
    [clip, graphWidth],
  );

  const announce = useCallback((message: string) => {
    setLiveStatus(message);
    const el = announceRef.current;
    if (el) el.textContent = message;
  }, []);

  const commitTrack = useCallback(
    (next: Keyframe[] | undefined, message?: string) => {
      const automation: ClipAutomation = { ...(clip.automation ?? {}) };
      if (next?.length) automation.playbackRate = next;
      else delete automation.playbackRate;
      onChange(normalizeClipAutomation(automation));
      if (message) announce(message);
    },
    [announce, clip.automation, onChange],
  );

  const clientToLocal = useCallback(
    (clientX: number, clientY: number, snap = false) => {
      const el = laneRef.current?.querySelector('.speed-lane-graph-area');
      if (!el) return { t: 0, rate: 1 };
      const rect = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      let t = x * duration;
      if (snap) t = snapOutputLocalToMarkers(t, snapTimes);
      const y = clientY - rect.top;
      return { t, rate: yToRate(y, height) };
    },
    [duration, height, snapTimes],
  );

  const handleAdd = (event: MouseEvent) => {
    if ((event.target as Element).closest('.speed-lane-key-btn')) return;
    const { t, rate } = clientToLocal(event.clientX, event.clientY);
    const next = upsertKeyframe(track, t, rate, duration * 0.02);
    commitTrack(
      next,
      `Added speed keyframe at ${t.toFixed(2)} seconds, ${formatPlaybackRateAria(rate)}`,
    );
    const idx = sortKeyframes(next).findIndex((k) => Math.abs(k.t - t) < duration * 0.02);
    setSelectedIndex(idx >= 0 ? idx : null);
  };

  const removeAtIndex = useCallback(
    (index: number) => {
      const key = track[index];
      if (!key) return;
      commitTrack(
        removeKeyframeAt(track, key.t, duration * 0.02),
        `Removed speed keyframe at ${key.t.toFixed(2)} seconds`,
      );
      setSelectedIndex(null);
      setDragPreview(null);
    },
    [commitTrack, duration, track],
  );

  const commitEdits = useCallback(() => {
    laneRef.current?.blur();
    announce('Speed keyframe edits committed');
  }, [announce]);

  const startDrag = (index: number, pointerId: number) => {
    setSelectedIndex(index);
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const snap = event.altKey;
      const { t, rate } = clientToLocal(event.clientX, event.clientY, snap);
      setDragPreview({ index, t, value: rate });
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const snap = event.altKey;
      const { t, rate } = clientToLocal(event.clientX, event.clientY, snap);
      const next = [...track];
      next[index] = { ...next[index], t, value: rate };
      const sorted = sortKeyframes(next);
      commitTrack(
        sorted,
        `Speed keyframe at ${t.toFixed(2)} seconds, ${formatPlaybackRateAria(rate)}`,
      );
      const newIndex = sorted.findIndex((k) => Math.abs(k.t - t) < duration * 0.02);
      setSelectedIndex(newIndex >= 0 ? newIndex : index);
      setDragPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const nudgeSelected = useCallback(
    (deltaT: number, deltaRate: number) => {
      if (selectedIndex == null || !track[selectedIndex]) return;
      const key = track[selectedIndex];
      const t = Math.min(duration, Math.max(0, key.t + deltaT));
      const value = clampClipPlaybackRate(key.value + deltaRate);
      const next = [...track];
      next[selectedIndex] = { ...next[selectedIndex], t, value };
      const sorted = sortKeyframes(next);
      const newIndex = sorted.findIndex(
        (k) => Math.abs(k.t - t) < 1e-6 && Math.abs(k.value - value) < 1e-6,
      );
      commitTrack(sorted);
      setSelectedIndex(newIndex >= 0 ? newIndex : selectedIndex);
      announce(
        `Speed keyframe at ${t.toFixed(2)} seconds, ${formatPlaybackRateAria(value)}`,
      );
    },
    [announce, commitTrack, duration, selectedIndex, track],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const fine = event.shiftKey;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        nudgeSelected(-(fine ? SPEED_KEYFRAME_TIME_NUDGE_FINE_SEC : SPEED_KEYFRAME_TIME_NUDGE_SEC), 0);
        break;
      case 'ArrowRight':
        event.preventDefault();
        nudgeSelected(fine ? SPEED_KEYFRAME_TIME_NUDGE_FINE_SEC : SPEED_KEYFRAME_TIME_NUDGE_SEC, 0);
        break;
      case 'ArrowDown':
        event.preventDefault();
        nudgeSelected(0, -(fine ? SPEED_KEYFRAME_RATE_NUDGE_FINE : SPEED_KEYFRAME_RATE_NUDGE));
        break;
      case 'ArrowUp':
        event.preventDefault();
        nudgeSelected(0, fine ? SPEED_KEYFRAME_RATE_NUDGE_FINE : SPEED_KEYFRAME_RATE_NUDGE);
        break;
      case 'Delete':
      case 'Backspace':
        if (selectedIndex != null) {
          event.preventDefault();
          removeAtIndex(selectedIndex);
        }
        break;
      case 'Enter':
        event.preventDefault();
        commitEdits();
        break;
      default:
        break;
    }
  };

  const seedFlat = useCallback(
    (rate: number) => {
      const clamped = clampClipPlaybackRate(rate);
      setLastSeedRate(clamped);
      commitTrack(
        [
          { t: 0, value: clamped },
          { t: duration, value: clamped },
        ],
        `Seeded flat speed curve at ${formatPlaybackRateAria(clamped)}`,
      );
    },
    [commitTrack, duration],
  );

  useEffect(() => {
    if (selectedIndex != null && selectedIndex >= track.length) {
      setSelectedIndex(track.length > 0 ? track.length - 1 : null);
    }
  }, [selectedIndex, track.length]);

  const pathD = curve
    .map((p, i) => {
      const x = (p.t / duration) * graphWidth;
      const y = rateToY(p.rate, height);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const baselineY = rateToY(1, height);
  const playheadClamped =
    playheadLocal != null
      ? Math.min(duration, Math.max(0, playheadLocal))
      : null;
  const playheadX =
    playheadClamped != null ? (playheadClamped / duration) * graphWidth : null;
  const playheadRate = samplePlaybackRateAt(clip, playheadClamped ?? 0);
  const playheadSource =
    playheadClamped != null ? sourceTimeAtOutputLocal(clip, playheadClamped) : null;
  const sourceConsumed =
    playheadClamped != null && playheadSource != null
      ? playheadSource - clip.trimStart
      : null;
  const trimmedSourceLen = Math.max(
    0.1,
    (Number.isFinite(clip.trimEnd) ? (clip.trimEnd as number) : clip.duration) - clip.trimStart,
  );
  const sourceHighlightWidth =
    sourceConsumed != null
      ? Math.min(graphWidth, (sourceConsumed / trimmedSourceLen) * graphWidth)
      : null;

  const displayTrack = track.map((key, index) => {
    if (dragPreview?.index === index) {
      return { ...key, t: dragPreview.t, value: dragPreview.value };
    }
    return key;
  });

  const sampledRateLabel = formatPlaybackRateLabel(playheadRate);
  const lastSeed = getLastSeedRate();

  return (
    <div
      ref={laneRef}
      className="speed-lane"
      style={{ width, minHeight: height + 28 }}
      tabIndex={0}
      role="group"
      aria-label="Speed automation lane. Click to add keyframes. Use arrow keys to nudge the selected keyframe."
      onKeyDown={handleKeyDown}
    >
      <div className="speed-lane-body" style={{ height }}>
        <div className="speed-lane-scale-gutter" aria-hidden="true">
          {speedLaneRateTicks().map((tick) => (
            <span
              key={tick}
              className="speed-lane-scale-label"
              style={{ top: `${(rateToY(tick, height) / height) * 100}%` }}
            >
              {formatPlaybackRateLabel(tick)}
            </span>
          ))}
        </div>

        <div
          className="speed-lane-graph-area"
          style={{ width: graphWidth, height }}
          onClick={handleAdd}
          role="slider"
          aria-label="Speed curve"
          aria-valuemin={MIN_CLIP_PLAYBACK_RATE}
          aria-valuemax={MAX_CLIP_PLAYBACK_RATE}
          aria-valuenow={playheadRate}
          aria-valuetext={
            playheadClamped != null
              ? `${formatPlaybackRateAria(playheadRate)} at ${playheadClamped.toFixed(2)} seconds`
              : formatPlaybackRateAria(playheadRate)
          }
        >
          <svg
            className="speed-lane-svg"
            width={graphWidth}
            height={height}
            viewBox={`0 0 ${graphWidth} ${height}`}
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(201, 162, 39, 0.14)" />
                <stop offset={`${((height - rateToY(1, height)) / height) * 100}%`} stopColor="rgba(201, 162, 39, 0.06)" />
                <stop offset="100%" stopColor="rgba(120, 140, 180, 0.1)" />
              </linearGradient>
            </defs>
            <rect
              x={0}
              y={0}
              width={graphWidth}
              height={height}
              className="speed-lane-gradient"
              fill={`url(#${gradientId})`}
            />
            {speedLaneRateTicks().map((tick) => {
              const y = rateToY(tick, height);
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={graphWidth}
                  y1={y}
                  y2={y}
                  className={`speed-lane-tick${tick === 1 ? ' speed-lane-tick--baseline' : ''}`}
                />
              );
            })}
            {sourceHighlightWidth != null && sourceHighlightWidth > 0 && (
              <rect
                x={0}
                y={0}
                width={sourceHighlightWidth}
                height={height}
                className="speed-lane-source-region"
              />
            )}
            <line
              x1={0}
              x2={graphWidth}
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
          </svg>

          {displayTrack.map((key, index) => {
            const xPct = (key.t / duration) * 100;
            const yPct = (rateToY(key.value, height) / height) * 100;
            const selected = selectedIndex === index;
            const label = formatPlaybackRateLabel(key.value);
            return (
              <button
                key={`${key.t}-${index}`}
                type="button"
                className={`speed-lane-key-btn${selected ? ' is-selected' : ''}`}
                style={{
                  left: `${xPct}%`,
                  top: `${yPct}%`,
                  width: SPEED_KEYFRAME_HIT_PX,
                  height: SPEED_KEYFRAME_HIT_PX,
                }}
                title={keyframeTitle(key)}
                aria-label={`Speed keyframe, ${key.t.toFixed(2)} seconds, ${formatPlaybackRateAria(key.value)}`}
                aria-pressed={selected}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedIndex(index);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  commitEdits();
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedIndex(index);
                  startDrag(index, event.pointerId);
                }}
              >
                <span className="speed-lane-key-shape" aria-hidden="true" />
                <span className="speed-lane-key-label" aria-hidden="true">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="speed-lane-caption">
        <div
          className={`speed-lane-rate-live${playheadClamped != null ? ' is-active' : ''}`}
          aria-live="polite"
        >
          {playheadClamped != null ? (
            <>
              <span className="speed-lane-rate-value">{sampledRateLabel}</span>
              <span className="speed-lane-rate-meta">
                @ {playheadClamped.toFixed(2)}s
                {playheadSource != null && (
                  <span className="speed-lane-source-at">
                    · src {playheadSource.toFixed(2)}s
                  </span>
                )}
              </span>
            </>
          ) : (
            <span className="speed-lane-rate-meta">
              Speed {sampledRateLabel}
              {track.length === 0 ? ' · click lane to add keyframes' : ` · ${track.length} keys`}
            </span>
          )}
        </div>

        <div className="speed-lane-seed-group" role="group" aria-label="Seed flat speed curve">
          <button
            type="button"
            className="speed-lane-seed"
            title={`Seed flat curve from constant speed (${getClipPlaybackRate(clip).toFixed(2)}×)`}
            onClick={(e) => {
              e.stopPropagation();
              seedFlat(getClipPlaybackRate(clip));
            }}
          >
            Seed
          </button>
          <button
            type="button"
            className="speed-lane-seed"
            title="Seed a flat 1× curve (realtime)"
            onClick={(e) => {
              e.stopPropagation();
              seedFlat(1);
            }}
          >
            Seed 1×
          </button>
          {Math.abs(lastSeed - 1) > 1e-6 && (
            <button
              type="button"
              className="speed-lane-seed"
              title={`Seed flat curve at last used rate (${formatPlaybackRateLabel(lastSeed)})`}
              onClick={(e) => {
                e.stopPropagation();
                seedFlat(lastSeed);
              }}
            >
              Seed {formatPlaybackRateLabel(lastSeed)}
            </button>
          )}
        </div>
      </div>

      <div ref={announceRef} className="speed-lane-sr-status" aria-live="assertive">
        {liveStatus}
      </div>
    </div>
  );
}
