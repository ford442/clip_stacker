import { useRef } from 'react';
import {
  DEFAULT_PRIMARY_COLOR,
  type PrimaryColorPass,
} from '../utils/finishing';

interface Props {
  settings: PrimaryColorPass;
  onChange: (settings: PrimaryColorPass) => void;
}

function formatSigned(value: number, digits = 2): string {
  const rounded = Number(value.toFixed(digits));
  return rounded > 0 ? `+${rounded}` : String(rounded);
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

function RgbTripletRow({
  label,
  title,
  min,
  max,
  step,
  value,
  onValue,
}: {
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
  value: [number, number, number];
  onValue: (v: [number, number, number]) => void;
}) {
  const channels: Array<{ key: 'R' | 'G' | 'B'; index: 0 | 1 | 2 }> = [
    { key: 'R', index: 0 },
    { key: 'G', index: 1 },
    { key: 'B', index: 2 },
  ];
  return (
    <div className="primary-color-triplet" title={title}>
      <div className="primary-color-triplet-label">{label}</div>
      {channels.map(({ key, index }) => (
        <label key={key} className="primary-color-channel">
          {key} ({formatSigned(value[index])})
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value[index]}
            onChange={(e) => {
              const next: [number, number, number] = [...value];
              next[index] = Number(e.target.value);
              onValue(next);
            }}
          />
        </label>
      ))}
    </div>
  );
}

export function PrimaryColorPanel({ settings, onChange }: Props) {
  const prevAmountRef = useRef(settings.amount ?? 1);
  const patch = (partial: Partial<PrimaryColorPass>) =>
    onChange({ ...settings, ...partial });

  const showingBefore = settings.enabled && (settings.amount ?? 1) <= 0;

  return (
    <div className="primary-color-panel">
      <div className="inspector-group-label">Primary color</div>
      <p className="inspector-hint">
        Technical correction before the creative LUT — exposure, WB, and
        lift/gamma/gain. WebGPU preview and GPU export are WYSIWYG; FFmpeg is
        best-effort. Canvas2D is ungraded.
      </p>

      <div className="primary-color-toolbar">
        <label className="finishing-pass-toggle" title="Enable primary color correction">
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
            title="Bypass primary only for before/after compare"
          >
            <input
              type="checkbox"
              checked={showingBefore}
              onChange={(e) => {
                if (e.target.checked) {
                  prevAmountRef.current =
                    (settings.amount ?? 1) > 0 ? (settings.amount ?? 1) : prevAmountRef.current;
                  patch({ amount: 0 });
                } else {
                  patch({ amount: prevAmountRef.current > 0 ? prevAmountRef.current : 1 });
                }
              }}
            />
            Show before
          </label>
        )}
        <button
          type="button"
          className="btn-secondary primary-color-reset-btn"
          onClick={() =>
            onChange({
              ...DEFAULT_PRIMARY_COLOR,
              enabled: settings.enabled,
              amount: settings.amount ?? 1,
            })
          }
        >
          Reset to neutral
        </button>
      </div>

      {settings.enabled && (
        <>
          {!showingBefore && (
            <SliderRow
              label="Amount"
              title="Blend between original and graded result"
              min={0}
              max={1}
              step={0.01}
              value={settings.amount ?? 1}
              display={`${Math.round((settings.amount ?? 1) * 100)}%`}
              onValue={(amount) => {
                if (amount > 0) prevAmountRef.current = amount;
                patch({ amount });
              }}
            />
          )}

          <div className="primary-color-group-label">Tone</div>
          <SliderRow
            label="Exposure"
            title="EV offset (−3 … +3)"
            min={-3}
            max={3}
            step={0.01}
            value={settings.exposure}
            display={`${formatSigned(settings.exposure)} EV`}
            onValue={(exposure) => patch({ exposure })}
          />
          <SliderRow
            label="Contrast"
            title="Pivot-based contrast (pivot 0.18 middle gray)"
            min={0}
            max={2}
            step={0.01}
            value={settings.contrast}
            display={settings.contrast.toFixed(2)}
            onValue={(contrast) => patch({ contrast })}
          />
          <SliderRow
            label="Saturation"
            title="Color saturation (1 = neutral)"
            min={0}
            max={2}
            step={0.01}
            value={settings.saturation}
            display={settings.saturation.toFixed(2)}
            onValue={(saturation) => patch({ saturation })}
          />

          <div className="primary-color-group-label">White balance</div>
          <SliderRow
            label="Temperature"
            title="Cool (−) ↔ warm (+)"
            min={-1}
            max={1}
            step={0.01}
            value={settings.temperature}
            display={formatSigned(settings.temperature)}
            onValue={(temperature) => patch({ temperature })}
          />
          <SliderRow
            label="Tint"
            title="Magenta (−) ↔ green (+)"
            min={-1}
            max={1}
            step={0.01}
            value={settings.tint}
            display={formatSigned(settings.tint)}
            onValue={(tint) => patch({ tint })}
          />

          <div className="primary-color-group-label">Lift / Gamma / Gain</div>
          <RgbTripletRow
            label="Lift"
            title="Shadows offset (DaVinci-style)"
            min={-1}
            max={1}
            step={0.01}
            value={settings.lift}
            onValue={(lift) => patch({ lift })}
          />
          <RgbTripletRow
            label="Gamma"
            title="Midtone power (1 = neutral)"
            min={0.1}
            max={3}
            step={0.01}
            value={settings.gamma}
            onValue={(gamma) => patch({ gamma })}
          />
          <RgbTripletRow
            label="Gain"
            title="Highlights multiply (1 = neutral)"
            min={0}
            max={2}
            step={0.01}
            value={settings.gain}
            onValue={(gain) => patch({ gain })}
          />
        </>
      )}
    </div>
  );
}
