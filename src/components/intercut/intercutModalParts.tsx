/**
 * Pieces of the Intercut modal: its option lists, the easing lookup and the
 * labelled source-clip picker.
 */

import type { Clip } from '../../types';
import { EASING_PRESETS, type KeyframeEasing } from '../../timeline/keyframes';







export type FrequencyUnit = 'hz' | 'sec';
export type EasingName = 'linear' | keyof typeof EASING_PRESETS;
export type CutTimingMode = 'frequency' | 'intervalList';

export const DEFAULT_INTERVALS_SEC = [2, 1, 1, 2, 3, 2];
export const DEFAULT_INTERVAL_LIST_TEXT = DEFAULT_INTERVALS_SEC.join(', ');

export const EASING_OPTIONS: { id: EasingName; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease in (ramp up)' },
  { id: 'easeOut', label: 'Ease out (ramp down)' },
  { id: 'easeInOut', label: 'Ease in-out (S-curve)' },
  { id: 'bellCurveSmooth', label: 'Bell curve: Smooth (sine ramp up & down)' },
  { id: 'bellCurveSharp', label: 'Bell curve: Sharp (exponential peak)' },
];

export function easingFromName(name: EasingName): KeyframeEasing | undefined {
  if (name === 'linear') return { type: 'linear' };
  return EASING_PRESETS[name];
}

function sourceClipLabel(clip: Clip): string {
  const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const duration = Math.max(0, trimEnd - clip.trimStart);
  const size =
    clip.videoWidth && clip.videoHeight
      ? ` · ${clip.videoWidth}×${clip.videoHeight}`
      : '';
  return `${clip.title} (${duration.toFixed(1)}s${size})`;
}

export function SourceSelect({
  letter,
  label,
  value,
  onChange,
  disabled,
  clips,
  emptyLabel,
  className,
}: {
  letter: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  clips: Clip[];
  emptyLabel: string;
  className?: string;
}) {
  return (
    <label className={`intercut-field intercut-source-field${className ? ` ${className}` : ''}`}>
      <span className="intercut-source-heading">
        <span className="intercut-source-letter" aria-hidden="true">
          {letter}
        </span>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
      >
        <option value="">{emptyLabel}</option>
        {clips.map((c) => (
          <option key={c.id} value={c.id}>
            {sourceClipLabel(c)}
          </option>
        ))}
      </select>
    </label>
  );
}
