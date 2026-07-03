import { useCallback, useMemo, useRef } from 'react';
import type { Keyframe, KeyframeEasing } from '../utils/keyframes';
import {
  DEFAULT_LINEAR_EASING,
  EASING_PRESETS,
  removeKeyframeAt,
  sampleKeyframes,
  sortKeyframes,
  upsertKeyframe,
} from '../utils/keyframes';

export interface KeyframeMiniEditorProps {
  label: string;
  duration: number;
  currentTime: number;
  keyframes: Keyframe[] | undefined;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (keyframes: Keyframe[] | undefined) => void;
}

const EASING_OPTIONS: Array<{ id: string; label: string; easing: KeyframeEasing }> = [
  { id: 'linear', label: 'Linear', easing: DEFAULT_LINEAR_EASING },
  { id: 'easeIn', label: 'Ease in', easing: EASING_PRESETS.easeIn },
  { id: 'easeOut', label: 'Ease out', easing: EASING_PRESETS.easeOut },
  { id: 'easeInOut', label: 'Ease in-out', easing: EASING_PRESETS.easeInOut },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTime(t: number): string {
  return t.toFixed(2);
}

export function KeyframeMiniEditor({
  label,
  duration,
  currentTime,
  keyframes,
  defaultValue,
  min = -Infinity,
  max = Infinity,
  step = 1,
  onChange,
}: KeyframeMiniEditorProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const safeDuration = Math.max(duration, 0.1);
  const track = useMemo(() => sortKeyframes(keyframes ?? []), [keyframes]);
  const sampled = sampleKeyframes(keyframes, currentTime, defaultValue);

  const timeToX = useCallback(
    (t: number) => `${(clamp(t, 0, safeDuration) / safeDuration) * 100}%`,
    [safeDuration],
  );

  const xToTime = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * safeDuration;
    },
    [safeDuration],
  );

  const handleAddAtPlayhead = () => {
    const t = clamp(currentTime, 0, safeDuration);
    const value = clamp(sampled, min, max);
    onChange(upsertKeyframe(keyframes, t, value));
  };

  const handleRemoveAtPlayhead = () => {
    const t = clamp(currentTime, 0, safeDuration);
    const next = removeKeyframeAt(keyframes, t);
    onChange(next);
  };

  const startDrag = (index: number, pointerId: number) => {
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const t = clamp(xToTime(event.clientX), 0, safeDuration);
      const next = [...track];
      next[index] = { ...next[index], t };
      onChange(sortKeyframes(next));
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="kf-editor">
      <div className="kf-editor-header">
        <span className="kf-editor-label">{label}</span>
        <span className="kf-editor-value" title="Sampled value at playhead">
          {sampled.toFixed(step < 0.1 ? 2 : 0)}
        </span>
      </div>

      <div
        ref={trackRef}
        className="kf-track"
        role="slider"
        aria-label={`${label} keyframe track`}
        aria-valuemin={0}
        aria-valuemax={safeDuration}
        aria-valuenow={currentTime}
      >
        <div
          className="kf-playhead"
          style={{ left: timeToX(currentTime) }}
          aria-hidden="true"
        />
        {track.map((key, index) => (
          <button
            key={`${key.t}-${index}`}
            type="button"
            className="kf-key"
            style={{ left: timeToX(key.t) }}
            title={`t=${formatTime(key.t)} v=${key.value}`}
            onPointerDown={(event) => {
              event.preventDefault();
              startDrag(index, event.pointerId);
            }}
          />
        ))}
      </div>

      <div className="kf-editor-actions">
        <button type="button" className="btn-secondary kf-btn" onClick={handleAddAtPlayhead}>
          + Key @ {formatTime(currentTime)}s
        </button>
        <button
          type="button"
          className="btn-secondary kf-btn"
          onClick={handleRemoveAtPlayhead}
          disabled={track.length === 0}
        >
          − Remove
        </button>
      </div>

      {track.length > 0 && (
        <div className="kf-key-list">
          {track.map((key, index) => (
            <div key={`${key.t}-row-${index}`} className="kf-key-row">
              <label className="kf-key-field">
                t
                <input
                  type="number"
                  min={0}
                  max={safeDuration}
                  step={0.05}
                  value={Number(key.t.toFixed(3))}
                  onChange={(e) => {
                    const t = clamp(Number(e.target.value), 0, safeDuration);
                    const next = [...track];
                    next[index] = { ...next[index], t };
                    onChange(sortKeyframes(next));
                  }}
                />
              </label>
              <label className="kf-key-field">
                v
                <input
                  type="number"
                  step={step}
                  min={Number.isFinite(min) ? min : undefined}
                  max={Number.isFinite(max) ? max : undefined}
                  value={key.value}
                  onChange={(e) => {
                    const value = clamp(Number(e.target.value), min, max);
                    const next = [...track];
                    next[index] = { ...next[index], value };
                    onChange(sortKeyframes(next));
                  }}
                />
              </label>
              <label className="kf-key-field kf-easing-field">
                ease
                <select
                  value={
                    EASING_OPTIONS.find(
                      (opt) =>
                        opt.easing.type === key.easing?.type &&
                        opt.easing.x1 === key.easing?.x1 &&
                        opt.easing.y1 === key.easing?.y1,
                    )?.id ?? 'linear'
                  }
                  onChange={(e) => {
                    const preset = EASING_OPTIONS.find((opt) => opt.id === e.target.value);
                    const next = [...track];
                    next[index] = {
                      ...next[index],
                      easing: preset?.easing ?? DEFAULT_LINEAR_EASING,
                    };
                    onChange(sortKeyframes(next));
                  }}
                >
                  {EASING_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
