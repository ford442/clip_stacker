import { useRef } from 'react';
import {
  DEFAULT_GRAIN,
  type GrainPass,
} from '../utils/finishing';
import {
  GRAIN_AMOUNT_RECOMMENDED,
  GRAIN_PRESETS,
  applyGrainFilmStock,
  applyGrainPreset,
  grainMonochromeBias,
  type GrainPresetId,
  type GrainQuality,
} from '../utils/grain';
import {
  FLAT_GRAIN_RESPONSE,
  GRAIN_FILM_STOCKS,
  GRAIN_RESPONSE_MAX,
  normalizeGrainResponse,
  type GrainResponseCurve,
} from '../utils/filmGrain';

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
  const film = settings.quality === 'film';
  const monoBias = grainMonochromeBias(settings);
  const coherence = settings.temporalCoherence ?? 0;
  const response = normalizeGrainResponse(settings.response);
  const patchResponse = (partial: Partial<GrainResponseCurve>) =>
    patch({ response: { ...response, ...partial } });
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
        frame (export frame index); Film quality adds blue-noise grain, stock
        presets and optional temporal coherence. Vignette and halation are off by default.
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
          <label title="Classic: original hash grain. Film: blue-noise grain with round, clumped crystals, colour bias, temporal coherence and a response curve.">
            Quality
            <select
              value={film ? 'film' : 'classic'}
              onChange={(e) =>
                patch({ quality: e.target.value as GrainQuality })
              }
            >
              <option value="classic">Classic</option>
              <option value="film">Film (blue noise)</option>
            </select>
          </label>
          {film && (
            <div className="grain-preset-row">
              <span className="grain-group-label">Film stock</span>
              <div className="grain-preset-chips">
                {GRAIN_FILM_STOCKS.map((stock) => (
                  <button
                    key={stock.id}
                    type="button"
                    className="btn-secondary grain-preset-chip"
                    title={stock.description}
                    onClick={() => onChange(applyGrainFilmStock(settings, stock.id))}
                  >
                    {stock.label}
                  </button>
                ))}
              </div>
            </div>
          )}
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
          {film ? (
            <>
              <SliderRow
                label="Monochrome bias"
                title="Per-channel colour grain (0) to monochrome grain (1)"
                min={0}
                max={1}
                step={0.01}
                value={monoBias}
                display={`${Math.round(monoBias * 100)}%`}
                onValue={(v) =>
                  patch({ monochromeBias: v, monochrome: v >= 0.5 })
                }
              />
              <SliderRow
                label="Temporal coherence"
                title="0 = new grain every frame; higher values let each grain field evolve over up to 12 frames (less flicker). Frame-exact in preview and export."
                min={0}
                max={1}
                step={0.01}
                value={coherence}
                display={`${Math.round(coherence * 100)}%`}
                onValue={(v) => patch({ temporalCoherence: v })}
              />
              <span className="grain-group-label">Response</span>
              {(
                [
                  ['shadows', 'Shadows', 'Grain gain in the shadows'],
                  ['midtones', 'Midtones', 'Grain gain in the midtones'],
                  ['highlights', 'Highlights', 'Grain gain in the highlights'],
                ] as const
              ).map(([key, label, title]) => (
                <SliderRow
                  key={key}
                  label={label}
                  title={title}
                  min={0}
                  max={GRAIN_RESPONSE_MAX}
                  step={0.01}
                  value={response[key]}
                  display={response[key].toFixed(2)}
                  onValue={(v) => patchResponse({ [key]: v })}
                />
              ))}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => patch({ response: { ...FLAT_GRAIN_RESPONSE } })}
              >
                Flat response
              </button>
            </>
          ) : (
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
          )}

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
