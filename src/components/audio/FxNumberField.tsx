import { useEffect, useRef, useState } from 'react';

export interface FxNumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Display scale (e.g. 1000 shows seconds as ms). */
  scale?: number;
  title?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

/**
 * Numeric field shared by the clip insert and bus FX editors.
 *
 * Typing is free-form; only in-range values commit, and the field snaps back
 * to the stored value on blur — so "5" on the way to "500 Hz" is not clamped
 * to the 20 Hz minimum mid-keystroke.
 */
export function FxNumberField({
  label,
  value,
  min,
  max,
  step,
  scale = 1,
  title,
  disabled,
  onCommit,
}: FxNumberFieldProps) {
  const shown = Number((value * scale).toFixed(4));
  const [text, setText] = useState(String(shown));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(shown));
  }, [shown]);
  return (
    <label className="inspector-fx-field" title={title}>
      {label}
      <input
        type="number"
        min={min * scale}
        max={max * scale}
        step={step * scale}
        value={text}
        disabled={disabled}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(shown));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = Number(e.target.value) / scale;
          if (e.target.value.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            onCommit(parsed);
          }
        }}
      />
    </label>
  );
}

