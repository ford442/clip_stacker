import { useRef } from 'react';
import {
  DEFAULT_GRAIN,
  type GrainPass,
} from '../utils/finishing';
import {
  GRAIN_AMOUNT_RECOMMENDED,
  GRAIN_PRESETS,
  applyGrainPreset,
  type GrainPresetId,
} from '../utils/grain';

interface Props {
  settings: GrainPass;
  onChange: (settings: GrainPass) => void;
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

export function GrainPanel({ settings, onChange }: Props) {
  const prevAmountRef = useRef(settings.amount ?? GRAIN_AMOUNT_RECOMMENDED);
  const patch = (partial: Partial<GrainPass>) =>
    onChange({ ...settings, ...partial });

  const amount = settings.amount ?? GRAIN_AMOUNT_RECOMMENDED;
  const showingBefore =
    settings.enabled &&
    amount <= 0 &&
    !settings.vignette.enabled &&
    !settings.halation.enabled &&
    settings.bloomAmount <= 0;

  return (
    <div className="grain-panel">
      <div className="inspector-group-label">Film grain &amp; optical</div>
      <p className="inspector-hint">
        Final finishing pass after sharpen / LUT. Procedural grain animates per
        frame (export frame index). Vignette and halation are off by default.
        WebGPU preview/export are WYSIWYG; FFmpeg uses noise + vignette
        (halation best-effort). Canvas2D does not apply finishing.
      </p>

      <div className="grain-toolbar">
        <label
          className="finishing-pass-toggle"
          title="Enable film grain and optical effects"
        >
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
            title="Bypass grain / optical for before/after compare"
          >
            <input
              type="checkbox"
              checked={showingBefore}
              onChange={(e) => {
                if (e.target.checked) {
                  prevAmountRef.current =
                    amount > 0 ? amount : prevAmountRef.current;
                  patch({
                    amount: 0,
                    vignette: { ...settings.vignette, enabled: false },
                    halation: { ...settings.halation, enabled: false },
                    bloomAmount: 0,
                  });
                } else {
                  patch({
                    amount:
                      prevAmountRef.current > 0
                        ? prevAmountRef.current
                        : GRAIN_AMOUNT_RECOMMENDED,
                  });
                }
              }}
            />
            Show before
          </label>
        )}
        <button
          type="button"
          className="btn-secondary grain-reset-btn"
          onClick={() =>
            onChange({
              ...DEFAULT_GRAIN,
              enabled: settings.enabled,
              amount: settings.amount ?? GRAIN_AMOUNT_RECOMMENDED,
              vignette: { ...DEFAULT_GRAIN.vignette },
              halation: { ...DEFAULT_GRAIN.halation },
            })
          }
        >
          Reset defaults
        </button>
      </div>

      {settings.enabled && !showingBefore && (
        <>
          <div className="grain-preset-row">
            <span className="grain-group-label">Presets</span>
            <div className="grain-preset-chips">
              {GRAIN_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="btn-secondary grain-preset-chip"
                  onClick={() =>
                    onChange(
                      applyGrainPreset(settings, preset.id as GrainPresetId),
                    )
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <span className="grain-group-label">Grain</span>
          <SliderRow
            label="Amount"
            title="Grain strength (0 = bypass grain only)"
            min={0}
            max={1}
            step={0.01}
            value={amount}
            display={`${Math.round(amount * 100)}%`}
            onValue={(v) => patch({ amount: v })}
          />
          <SliderRow
            label="Size"
            title="Fine (0) to coarse (1) grain scale"
            min={0}
            max={1}
            step={0.01}
            value={settings.size}
            display={settings.size.toFixed(2)}
            onValue={(v) => patch({ size: v })}
          />
          <SliderRow
            label="Softness"
            title="Bias grain toward midtones vs extremes"
            min={0}
            max={1}
            step={0.01}
            value={settings.softness}
            display={`${Math.round(settings.softness * 100)}%`}
            onValue={(v) => patch({ softness: v })}
          />
          <label
            className="finishing-pass-toggle"
            title="Monochrome grain (default on)"
          >
            <input
              type="checkbox"
              checked={settings.monochrome}
              onChange={(e) => patch({ monochrome: e.target.checked })}
            />
            Monochrome
          </label>

          <span className="grain-group-label">Optical</span>
          <label
            className="finishing-pass-toggle"
            title="Radial vignette falloff"
          >
            <input
              type="checkbox"
              checked={settings.vignette.enabled}
              onChange={(e) =>
                patch({
                  vignette: { ...settings.vignette, enabled: e.target.checked },
                })
              }
            />
            Vignette
          </label>
          {settings.vignette.enabled && (
            <>
              <SliderRow
                label="Vignette amount"
                title="Edge darkening strength"
                min={0}
                max={1}
                step={0.01}
                value={settings.vignette.amount}
                display={`${Math.round(settings.vignette.amount * 100)}%`}
                onValue={(v) =>
                  patch({ vignette: { ...settings.vignette, amount: v } })
                }
              />
              <SliderRow
                label="Midpoint"
                title="Where falloff begins (0 center to 1 edges)"
                min={0}
                max={1}
                step={0.01}
                value={settings.vignette.midpoint}
                display={settings.vignette.midpoint.toFixed(2)}
                onValue={(v) =>
                  patch({ vignette: { ...settings.vignette, midpoint: v } })
                }
              />
              <SliderRow
                label="Roundness"
                title="Circular (0) to more rectangular (1)"
                min={0}
                max={1}
                step={0.01}
                value={settings.vignette.roundness}
                display={settings.vignette.roundness.toFixed(2)}
                onValue={(v) =>
                  patch({ vignette: { ...settings.vignette, roundness: v } })
                }
              />
            </>
          )}

          <label
            className="finishing-pass-toggle"
            title="Red-channel halation bloom"
          >
            <input
              type="checkbox"
              checked={settings.halation.enabled}
              onChange={(e) =>
                patch({
                  halation: {
                    ...settings.halation,
                    enabled: e.target.checked,
                  },
                })
              }
            />
            Halation
          </label>
          {settings.halation.enabled && (
            <>
              <SliderRow
                label="Halation amount"
                title="Red bloom mix strength"
                min={0}
                max={1}
                step={0.01}
                value={settings.halation.amount}
                display={`${Math.round(settings.halation.amount * 100)}%`}
                onValue={(v) =>
                  patch({
                    halation: { ...settings.halation, amount: v },
                  })
                }
              />
              <SliderRow
                label="Threshold"
                title="Brightness threshold for halation"
                min={0}
                max={1}
                step={0.01}
                value={settings.halation.threshold}
                display={settings.halation.threshold.toFixed(2)}
                onValue={(v) =>
                  patch({
                    halation: { ...settings.halation, threshold: v },
                  })
                }
              />
              <SliderRow
                label="Blur radius"
                title="Halation blur radius in pixels"
                min={0.5}
                max={32}
                step={0.5}
                value={settings.halation.radius}
                display={settings.halation.radius.toFixed(1)}
                onValue={(v) =>
                  patch({
                    halation: { ...settings.halation, radius: v },
                  })
                }
              />
            </>
          )}

          <SliderRow
            label="Bloom"
            title="Soft highlight bloom (shares blur with halation)"
            min={0}
            max={1}
            step={0.01}
            value={settings.bloomAmount}
            display={`${Math.round(settings.bloomAmount * 100)}%`}
            onValue={(v) => patch({ bloomAmount: v })}
          />
        </>
      )}
    </div>
  );
}
