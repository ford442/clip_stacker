import type { FinishingSettings } from '../utils/finishing';
import {
  DEFAULT_GRAIN,
  DEFAULT_NOISE_REDUCTION,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  DEFAULT_SHARPEN,
  lutPassToColorGrade,
  withColorGrade,
  withFinishingPass,
} from '../utils/finishing';
import { ColorGradePicker } from './ColorGradePicker';
import { NoiseReductionPanel } from './NoiseReductionPanel';
import { PrimaryColorPanel } from './PrimaryColorPanel';

interface Props {
  settings: FinishingSettings;
  onChange: (settings: FinishingSettings) => void;
}

const STUB_PASSES: Array<{
  key: 'secondaryColor' | 'sharpen' | 'grain';
  label: string;
  description: string;
  defaults: FinishingSettings[keyof FinishingSettings];
}> = [
  {
    key: 'secondaryColor',
    label: 'Secondary color',
    description: 'Selective hue / saturation grades (coming soon)',
    defaults: DEFAULT_SECONDARY_COLOR,
  },
  {
    key: 'sharpen',
    label: 'Sharpen / detail',
    description: 'Detail enhancement after creative grade (coming soon)',
    defaults: DEFAULT_SHARPEN,
  },
  {
    key: 'grain',
    label: 'Film grain',
    description: 'Grain and optical emulation — applied last (coming soon)',
    defaults: DEFAULT_GRAIN,
  },
];

export function FinishingPanel({ settings, onChange }: Props) {
  const lutGrade = lutPassToColorGrade(settings.lut);
  const primary = settings.primaryColor ?? DEFAULT_PRIMARY_COLOR;
  const noise = settings.noiseReduction ?? DEFAULT_NOISE_REDUCTION;

  return (
    <div className="finishing-panel">
      <div className="inspector-group-label">Finishing</div>
      <p className="inspector-hint">
        <span className="finishing-parity-badge">WebGPU + GPU export</span>
        {' — '}
        Noise reduction and primary color have best-effort FFmpeg parity;
        Canvas2D does not apply finishing.
      </p>

      <NoiseReductionPanel
        settings={noise}
        onChange={(next) =>
          onChange(withFinishingPass(settings, 'noiseReduction', next))
        }
      />

      <PrimaryColorPanel
        settings={primary}
        onChange={(next) => onChange(withFinishingPass(settings, 'primaryColor', next))}
      />

      {STUB_PASSES.map(({ key, label, description, defaults }) => {
        const pass = (settings[key] ?? defaults) as {
          enabled: boolean;
          amount?: number;
        };
        return (
          <div key={key} className="finishing-pass-row">
            <label className="finishing-pass-toggle" title={description}>
              <input
                type="checkbox"
                checked={pass.enabled}
                onChange={(e) =>
                  onChange(
                    withFinishingPass(settings, key, {
                      ...(settings[key] ?? defaults),
                      enabled: e.target.checked,
                    } as FinishingSettings[typeof key]),
                  )
                }
              />
              {label}
            </label>
            {pass.enabled && (
              <label className="finishing-pass-amount" title={`${label} strength`}>
                Amount ({Math.round((pass.amount ?? 1) * 100)}%)
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={pass.amount ?? 1}
                  onChange={(e) =>
                    onChange(
                      withFinishingPass(settings, key, {
                        ...(settings[key] ?? defaults),
                        amount: Number(e.target.value),
                      } as FinishingSettings[typeof key]),
                    )
                  }
                />
              </label>
            )}
            <p className="inspector-hint">{description}</p>
          </div>
        );
      })}

      <ColorGradePicker
        settings={lutGrade}
        onChange={(grade) => onChange(withColorGrade(settings, grade))}
      />
    </div>
  );
}
