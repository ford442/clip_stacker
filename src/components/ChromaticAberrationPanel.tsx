import { useRef } from 'react';
import {
  DEFAULT_CHROMATIC_ABERRATION,
  type ChromaticAberrationPass,
} from '../utils/finishing';
import { CA_AMOUNT_RECOMMENDED, CA_MAX_SHIFT } from '../utils/chromaticAberration';

interface Props {
  settings: ChromaticAberrationPass;
  onChange: (settings: ChromaticAberrationPass) => void;
}

function SliderRow({
  label,
  title,
  min,
  max,
  step,
  value,
  display,
  onValue,
}: {
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onValue: (v: number) => void;
}) {
  return (
    <label title={title}>
      {label} ({display})
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
      />
    </label>
  );
}

/** Fringe width in pixels at 1080p for a given amount (for the slider label). */
function fringePx1080(amount: number): string {
  return (amount * CA_MAX_SHIFT * 1080).toFixed(1);
}

export function ChromaticAberrationPanel({ settings, onChange }: Props) {
  const prevAmountRef = useRef(settings.amount ?? CA_AMOUNT_RECOMMENDED);
  const patch = (partial: Partial<ChromaticAberrationPass>) =>
    onChange({ ...settings, ...partial });

  const amount = settings.amount ?? CA_AMOUNT_RECOMMENDED;
  const showingBefore = settings.enabled && amount <= 0;

  return (
    <div className="chromatic-aberration-panel">
      <div className="inspector-group-label">Chromatic aberration</div>
      <p className="inspector-hint">
        Lens colour fringe after sharpen, before grain. Radial grows toward the
        frame edges like a real lens; Directional shifts red and blue along an
        angle. WebGPU preview/export only — FFmpeg and Canvas2D skip it (the
        render plan says so).
      </p>

      <div className="chromatic-aberration-toolbar">
        <label className="finishing-pass-toggle" title="Enable chromatic aberration">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enabled
        </label>
        {settings.enabled && (
          <label
            className="finishing-pass-toggle"
            title="Bypass chromatic aberration for before/after compare"
          >
            <input
              type="checkbox"
              checked={showingBefore}
              onChange={(e) => {
                if (e.target.checked) {
                  prevAmountRef.current = amount > 0 ? amount : prevAmountRef.current;
                  patch({ amount: 0 });
                } else {
                  patch({
                    amount:
                      prevAmountRef.current > 0
                        ? prevAmountRef.current
                        : CA_AMOUNT_RECOMMENDED,
                  });
                }
              }}
            />
            Show before
          </label>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            onChange({
              ...DEFAULT_CHROMATIC_ABERRATION,
              enabled: settings.enabled,
              amount,
            })
          }
        >
          Reset defaults
        </button>
      </div>

      {settings.enabled && !showingBefore && (
        <>
          <SliderRow
            label="Amount"
            title="Fringe width (shown in pixels at 1080p; scales with the frame)"
            min={0}
            max={1}
            step={0.01}
            value={amount}
            display={`${fringePx1080(amount)} px @1080p`}
            onValue={(v) => patch({ amount: v })}
          />
          <SliderRow
            label="Radial"
            title="1 = radial lens fringe (zero at the centre, strongest at the edges); 0 = uniform directional shift"
            min={0}
            max={1}
            step={0.01}
            value={settings.radial}
            display={`${Math.round(settings.radial * 100)}%`}
            onValue={(v) => patch({ radial: v })}
          />
          {settings.radial < 1 && (
            <SliderRow
              label="Angle"
              title="Direction of the directional shift (degrees, clockwise from right)"
              min={-180}
              max={180}
              step={1}
              value={settings.angle}
              display={`${Math.round(settings.angle)}°`}
              onValue={(v) => patch({ angle: v })}
            />
          )}
          <label
            className="finishing-pass-toggle"
            title="Soft spectral fringe (7 samples) instead of three hard colour copies"
          >
            <input
              type="checkbox"
              checked={settings.spectral}
              onChange={(e) => patch({ spectral: e.target.checked })}
            />
            Spectral fringe
          </label>
        </>
      )}
    </div>
  );
}
