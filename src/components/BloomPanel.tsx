import { useRef } from 'react';
import { DEFAULT_BLOOM, type BloomPass } from '../utils/finishing';
import { BLOOM_AMOUNT_RECOMMENDED, bloomSpread, type BloomMode } from '../utils/bloom';

interface Props {
  settings: BloomPass;
  onChange: (settings: BloomPass) => void;
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

const TINT_PRESETS: { label: string; tint: [number, number, number] }[] = [
  { label: 'Neutral', tint: [1, 1, 1] },
  { label: 'Warm', tint: [1, 0.82, 0.6] },
  { label: 'Cool', tint: [0.7, 0.85, 1] },
  { label: 'Magenta', tint: [1, 0.65, 0.9] },
];

const toHex = (tint: [number, number, number]) =>
  `#${tint
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

const fromHex = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export function BloomPanel({ settings, onChange }: Props) {
  const prevAmountRef = useRef(settings.amount ?? BLOOM_AMOUNT_RECOMMENDED);
  const patch = (partial: Partial<BloomPass>) => onChange({ ...settings, ...partial });

  const amount = settings.amount ?? BLOOM_AMOUNT_RECOMMENDED;
  const showingBefore = settings.enabled && amount <= 0;
  const wrap = settings.mode === 'lightWrap';

  return (
    <div className="bloom-panel">
      <div className="inspector-group-label">Bloom &amp; glow</div>
      <p className="inspector-hint">
        Multi-scale glow after chromatic aberration, before grain — separate
        from grain&apos;s halation. Light wrap pulls surrounding light over
        darker edges (e.g. a keyed overlay). WebGPU preview/export only —
        FFmpeg and Canvas2D skip it (the render plan says so).
      </p>

      <div className="bloom-toolbar">
        <label className="finishing-pass-toggle" title="Enable bloom / glow">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enabled
        </label>
        {settings.enabled && (
          <label className="finishing-pass-toggle" title="Bypass bloom for before/after compare">
            <input
              type="checkbox"
              checked={showingBefore}
              onChange={(e) => {
                if (e.target.checked) {
                  prevAmountRef.current = amount > 0 ? amount : prevAmountRef.current;
                  patch({ amount: 0 });
                } else {
                  patch({
                    amount: prevAmountRef.current > 0 ? prevAmountRef.current : BLOOM_AMOUNT_RECOMMENDED,
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
            onChange({ ...DEFAULT_BLOOM, enabled: settings.enabled, amount, tint: [1, 1, 1] })
          }
        >
          Reset defaults
        </button>
      </div>

      {settings.enabled && !showingBefore && (
        <>
          <label title="Bloom: glow from highlights. Light wrap: surrounding light over darker edges.">
            Mode
            <select
              value={settings.mode}
              onChange={(e) => patch({ mode: e.target.value as BloomMode })}
            >
              <option value="bloom">Bloom (highlights)</option>
              <option value="lightWrap">Light wrap (edges)</option>
            </select>
          </label>
          <SliderRow
            label={wrap ? 'Wrap' : 'Intensity'}
            title={wrap ? 'How much surrounding light wraps over darker edges' : 'Glow strength'}
            min={0}
            max={1}
            step={0.01}
            value={amount}
            display={`${Math.round(amount * 100)}%`}
            onValue={(v) => {
              if (v > 0) prevAmountRef.current = v;
              patch({ amount: v });
            }}
          />
          {!wrap && (
            <>
              <SliderRow
                label="Threshold"
                title="Brightness (brightest channel) where the glow starts"
                min={0}
                max={1}
                step={0.01}
                value={settings.threshold}
                display={settings.threshold.toFixed(2)}
                onValue={(v) => patch({ threshold: v })}
              />
              <SliderRow
                label="Softness"
                title="Soft knee around the threshold (0 = hard cut)"
                min={0}
                max={1}
                step={0.01}
                value={settings.softness}
                display={`${Math.round(settings.softness * 100)}%`}
                onValue={(v) => patch({ softness: v })}
              />
            </>
          )}
          <SliderRow
            label="Radius"
            title="Glow spread as a share of the frame height (same on preview and export)"
            min={0}
            max={1}
            step={0.01}
            value={settings.radius}
            display={`${(bloomSpread(settings.radius) * 100).toFixed(1)}% of height`}
            onValue={(v) => patch({ radius: v })}
          />
          <div className="bloom-tint-row">
            <label title="Glow colour (white = neutral)">
              Tint
              <input
                type="color"
                value={toHex(settings.tint)}
                onChange={(e) => patch({ tint: fromHex(e.target.value) })}
              />
            </label>
            {TINT_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="btn-secondary bloom-tint-chip"
                onClick={() => patch({ tint: [...preset.tint] })}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
