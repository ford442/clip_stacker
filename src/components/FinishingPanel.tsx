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
import { SharpenPanel } from './SharpenPanel';

interface Props {
  settings: FinishingSettings;
  onChange: (settings: FinishingSettings) => void;
}

const STUB_PASSES: Array<{
  key: 'secondaryColor' | 'grain';
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
  const sharpen = settings.sharpen ?? DEFAULT_SHARPEN;
  const secondaryStub = STUB_PASSES.find((p) => p.key === 'secondaryColor')!;
  const grainStub = STUB_PASSES.find((p) => p.key === 'grain')!;

  const renderStub = ({
    key,
    label,
    description,
    defaults,
  }: (typeof STUB_PASSES)[number]) => {
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
  };

  return (
    <div className="finishing-panel">
      <div className="inspector-group-label">Finishing</div>
      <p className="inspector-hint">
        <span className="finishing-parity-badge">WebGPU + GPU export</span>
        {' — '}
        Noise, primary color, and sharpen have best-effort FFmpeg parity;
        Canvas2D does not apply finishing. Order: noise → primary → secondary →
        LUT → sharpen → grain.
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

      {renderStub(secondaryStub)}

      <ColorGradePicker
        settings={lutGrade}
        onChange={(grade) => onChange(withColorGrade(settings, grade))}
      />

      <SharpenPanel
        settings={sharpen}
        onChange={(next) => onChange(withFinishingPass(settings, 'sharpen', next))}
      />

      {renderStub(grainStub)}
    </div>
  );
}
