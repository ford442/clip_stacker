import type { FinishingSettings } from '../utils/finishing';
import {
  DEFAULT_CHROMATIC_ABERRATION,
  DEFAULT_GRAIN,
  DEFAULT_NOISE_REDUCTION,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  DEFAULT_SHARPEN,
  lutPassToColorGrade,
  withColorGrade,
  withFinishingPass,
} from '../utils/finishing';
import { ChromaticAberrationPanel } from './ChromaticAberrationPanel';
import { ColorGradePicker } from './ColorGradePicker';
import { GrainPanel } from './GrainPanel';
import { NoiseReductionPanel } from './NoiseReductionPanel';
import { PrimaryColorPanel } from './PrimaryColorPanel';
import { SecondaryColorPanel } from './SecondaryColorPanel';
import { SharpenPanel } from './SharpenPanel';

interface Props {
  settings: FinishingSettings;
  onChange: (settings: FinishingSettings) => void;
}

export function FinishingPanel({ settings, onChange }: Props) {
  const lutGrade = lutPassToColorGrade(settings.lut);
  const primary = settings.primaryColor ?? DEFAULT_PRIMARY_COLOR;
  const secondary = settings.secondaryColor ?? DEFAULT_SECONDARY_COLOR;
  const noise = settings.noiseReduction ?? DEFAULT_NOISE_REDUCTION;
  const sharpen = settings.sharpen ?? DEFAULT_SHARPEN;
  const chromaticAberration = settings.chromaticAberration ?? DEFAULT_CHROMATIC_ABERRATION;
  const grain = settings.grain ?? DEFAULT_GRAIN;

  return (
    <div className="finishing-panel">
      <p className="inspector-hint">
        <span className="finishing-parity-badge">WebGPU + GPU export</span>
        {' — '}
        Noise, primary, secondary (hue→lut3d), sharpen, and grain have
        best-effort FFmpeg parity; window secondaries, creative LUT and
        chromatic aberration are WebGPU-only. Canvas2D does not apply
        finishing. Order: noise → primary → secondary → LUT → sharpen →
        chromatic aberration → grain.
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

      <SecondaryColorPanel
        settings={secondary}
        onChange={(next) =>
          onChange(withFinishingPass(settings, 'secondaryColor', next))
        }
      />

      <ColorGradePicker
        settings={lutGrade}
        onChange={(grade) => onChange(withColorGrade(settings, grade))}
      />

      <SharpenPanel
        settings={sharpen}
        onChange={(next) => onChange(withFinishingPass(settings, 'sharpen', next))}
      />

      <ChromaticAberrationPanel
        settings={chromaticAberration}
        onChange={(next) =>
          onChange(withFinishingPass(settings, 'chromaticAberration', next))
        }
      />

      <GrainPanel
        settings={grain}
        onChange={(next) => onChange(withFinishingPass(settings, 'grain', next))}
      />
    </div>
  );
}
