import { useRef } from 'react';
import {
  DEFAULT_SHARPEN,
  type SharpenPass,
} from '../utils/finishing';
import {
  SHARPEN_AMOUNT_RECOMMENDED,
  SHARPEN_AMOUNT_SOFT_CAP,
  SHARPEN_RADIUS_MAX,
  SHARPEN_RADIUS_MIN,
} from '../utils/sharpen';

interface Props {
  settings: SharpenPass;
  onChange: (settings: SharpenPass) => void;
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
  warning,
}: {
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onValue: (v: number) => void;
  warning?: string;
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
      {warning ? <span className="sharpen-soft-cap-warning">{warning}</span> : null}
    </label>
  );
}

export function SharpenPanel({ settings, onChange }: Props) {
  const prevAmountRef = useRef(settings.amount ?? SHARPEN_AMOUNT_RECOMMENDED);
  const prevMidtoneRef = useRef(settings.midtoneDetail ?? 0);
  const patch = (partial: Partial<SharpenPass>) =>
    onChange({ ...settings, ...partial });

  const amount = settings.amount ?? SHARPEN_AMOUNT_RECOMMENDED;
  const midtone = settings.midtoneDetail ?? 0;
  const showingBefore = settings.enabled && amount <= 0 && midtone <= 0;
  const amountOverSoftCap = amount > SHARPEN_AMOUNT_SOFT_CAP;

  return (
    <div className="sharpen-panel">
      <div className="inspector-group-label">Sharpening</div>
      <p className="inspector-hint">
        Gentle unsharp + midtone detail after the creative LUT, before grain.
        Restores edge definition after denoise. WebGPU preview/export are
        WYSIWYG; FFmpeg uses unsharp (luma only). Canvas2D is skipped.
        Recommended amount ≤ {SHARPEN_AMOUNT_RECOMMENDED}.
      </p>

      <div className="sharpen-toolbar">
        <label className="finishing-pass-toggle" title="Enable sharpening">
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
            title="Bypass sharpen only for before/after compare"
          >
            <input
              type="checkbox"
              checked={showingBefore}
              onChange={(e) => {
                if (e.target.checked) {
                  prevAmountRef.current =
                    amount > 0 ? amount : prevAmountRef.current;
                  prevMidtoneRef.current =
                    midtone > 0 ? midtone : prevMidtoneRef.current;
                  patch({ amount: 0, midtoneDetail: 0 });
                } else {
                  patch({
                    amount:
                      prevAmountRef.current > 0
                        ? prevAmountRef.current
                        : SHARPEN_AMOUNT_RECOMMENDED,
                    midtoneDetail: prevMidtoneRef.current,
                  });
                }
              }}
            />
            Show before
          </label>
        )}
        <button
          type="button"
          className="btn-secondary sharpen-reset-btn"
          onClick={() =>
            onChange({
              ...DEFAULT_SHARPEN,
              enabled: settings.enabled,
              amount: settings.amount ?? SHARPEN_AMOUNT_RECOMMENDED,
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
            title={`Unsharp strength (0–1). Soft cap ${SHARPEN_AMOUNT_SOFT_CAP} — higher looks digital.`}
            min={0}
            max={1}
            step={0.01}
            value={amount}
            display={`${Math.round(amount * 100)}%`}
            onValue={(v) => patch({ amount: v })}
            warning={
              amountOverSoftCap
                ? `Above ${Math.round(SHARPEN_AMOUNT_SOFT_CAP * 100)}% — may look harsh / digital`
                : undefined
            }
          />
          <SliderRow
            label="Radius"
            title="Unsharp blur radius in pixels"
            min={SHARPEN_RADIUS_MIN}
            max={SHARPEN_RADIUS_MAX}
            step={0.1}
            value={settings.radius}
            display={settings.radius.toFixed(1)}
            onValue={(v) => patch({ radius: v })}
          />
          <SliderRow
            label="Threshold"
            title="Skip sharpening on smooth areas (luma detail threshold)"
            min={0}
            max={0.2}
            step={0.005}
            value={settings.threshold}
            display={settings.threshold.toFixed(3)}
            onValue={(v) => patch({ threshold: v })}
          />
          <SliderRow
            label="Midtone detail"
            title="Local contrast boost in midtones (separate from edge unsharp)"
            min={0}
            max={1}
            step={0.01}
            value={midtone}
            display={`${Math.round(midtone * 100)}%`}
            onValue={(v) => patch({ midtoneDetail: v })}
          />
        </>
      )}
    </div>
  );
}
