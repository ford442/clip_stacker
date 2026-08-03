import { useRef } from 'react';
import {
  DEFAULT_NOISE_REDUCTION,
  type NoiseReductionPass,
} from '../utils/finishing';
import { NOISE_REDUCTION_MAX_RADIUS } from '../utils/noiseReduction';

interface Props {
  settings: NoiseReductionPass;
  onChange: (settings: NoiseReductionPass) => void;
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

export function NoiseReductionPanel({ settings, onChange }: Props) {
  const prevAmountRef = useRef(settings.amount ?? 1);
  const patch = (partial: Partial<NoiseReductionPass>) =>
    onChange({ ...settings, ...partial });

  const showingBefore = settings.enabled && (settings.amount ?? 1) <= 0;

  return (
    <div className="noise-reduction-panel">
      <div className="inspector-group-label">Noise reduction</div>
      <p className="inspector-hint">
        Spatial + optional temporal denoise — applied first, before color.
        WebGPU preview/export are WYSIWYG. FFmpeg fallback uses hqdn3d (slow).
        Canvas2D is ungraded.
      </p>

      <div className="noise-reduction-toolbar">
        <label className="finishing-pass-toggle" title="Enable noise reduction">
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
            title="Bypass NR only for before/after compare"
          >
            <input
              type="checkbox"
              checked={showingBefore}
              onChange={(e) => {
                if (e.target.checked) {
                  prevAmountRef.current =
                    (settings.amount ?? 1) > 0
                      ? (settings.amount ?? 1)
                      : prevAmountRef.current;
                  patch({ amount: 0 });
                } else {
                  patch({
                    amount: prevAmountRef.current > 0 ? prevAmountRef.current : 1,
                  });
                }
              }}
            />
            Show before
          </label>
        )}
        <button
          type="button"
          className="btn-secondary noise-reduction-reset-btn"
          onClick={() =>
            onChange({
              ...DEFAULT_NOISE_REDUCTION,
              enabled: settings.enabled,
              amount: settings.amount ?? 1,
            })
          }
        >
          Reset defaults
        </button>
      </div>

      {settings.enabled && (
        <>
          {!showingBefore && (
            <SliderRow
              label="Amount"
              title="Overall blend between original and denoised"
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

          <div className="noise-reduction-group-label">Spatial</div>
          <SliderRow
            label="Strength"
            title="Edge-aware bilateral strength (0 = off)"
            min={0}
            max={1}
            step={0.01}
            value={settings.spatialStrength}
            display={settings.spatialStrength.toFixed(2)}
            onValue={(spatialStrength) => patch({ spatialStrength })}
          />
          <SliderRow
            label="Radius"
            title={`Kernel radius in pixels (max ${NOISE_REDUCTION_MAX_RADIUS})`}
            min={0}
            max={NOISE_REDUCTION_MAX_RADIUS}
            step={0.5}
            value={settings.spatialRadius}
            display={settings.spatialRadius.toFixed(1)}
            onValue={(spatialRadius) => patch({ spatialRadius })}
          />

          <div className="noise-reduction-group-label">Temporal</div>
          <label
            className="finishing-pass-toggle"
            title="Blend with previous frame (cleared on seek / scrub-back)"
          >
            <input
              type="checkbox"
              checked={settings.temporal}
              onChange={(e) => patch({ temporal: e.target.checked })}
            />
            Enable temporal
          </label>
          {settings.temporal && (
            <>
              <SliderRow
                label="Strength"
                title="Temporal blend amount on static regions"
                min={0}
                max={1}
                step={0.01}
                value={settings.temporalStrength}
                display={settings.temporalStrength.toFixed(2)}
                onValue={(temporalStrength) => patch({ temporalStrength })}
              />
              <SliderRow
                label="Motion threshold"
                title="Skip temporal blend when luma change exceeds this (anti-ghost)"
                min={0.01}
                max={0.4}
                step={0.01}
                value={settings.temporalMotionThreshold}
                display={settings.temporalMotionThreshold.toFixed(2)}
                onValue={(temporalMotionThreshold) =>
                  patch({ temporalMotionThreshold })
                }
              />
            </>
          )}

          <div className="noise-reduction-group-label">Options</div>
          <label
            className="finishing-pass-toggle"
            title="Denoise luminance only; preserve source chroma (recommended)"
          >
            <input
              type="checkbox"
              checked={settings.lumaOnly !== false}
              onChange={(e) => patch({ lumaOnly: e.target.checked })}
            />
            Luma only
          </label>
          <label
            className="finishing-pass-toggle"
            title="Cheaper spatial kernel for live preview (export still uses full settings when Draft is off)"
          >
            <input
              type="checkbox"
              checked={Boolean(settings.draft)}
              onChange={(e) => patch({ draft: e.target.checked })}
            />
            Draft NR (preview)
          </label>
          <p className="inspector-hint">
            Export runs full-res spatial NR. Temporal NR and high radius can
            increase encode time significantly on the FFmpeg path.
          </p>
        </>
      )}
    </div>
  );
}
