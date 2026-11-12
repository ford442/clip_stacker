import type { Clip, SourceColorSpaceOverride } from '../../types';
import { useSourceColorSpace } from '../../hooks/useSourceColorSpace';
import {
  SOURCE_COLOR_SPACE_OVERRIDES,
  isSourceColorSpaceOverride,
  sourceColorSpaceLine,
} from '../../media/sourceColorSpace';

interface SourceColorSpaceFieldProps {
  clip: Clip;
  onChange?: (override: SourceColorSpaceOverride | undefined) => void;
}

/**
 * "Source: Rec.2020 PQ (from file)" and, when editable, an "Interpret as"
 * override for a mistagged or untagged file (applied on the decoder path).
 */
export function SourceColorSpaceField({ clip, onChange }: SourceColorSpaceFieldProps) {
  const fileTags = useSourceColorSpace(clip.file);
  const line =
    fileTags === undefined && !clip.colorSpaceOverride
      ? 'Source: reading colour tags…'
      : sourceColorSpaceLine(fileTags ?? null, clip.colorSpaceOverride);
  return (
    <div className="inspector-source-color">
      <p className="inspector-hint" data-testid="source-color-space">
        {line}
      </p>
      {onChange && (
        <label title="Interpret the source as another colour space when its tags are wrong or missing. Applies to the decoded preview and the GPU export.">
          Interpret as
          <select
            value={clip.colorSpaceOverride ?? ''}
            onChange={(e) =>
              onChange(isSourceColorSpaceOverride(e.target.value) ? e.target.value : undefined)
            }
          >
            <option value="">From file</option>
            {SOURCE_COLOR_SPACE_OVERRIDES.map((def) => (
              <option key={def.id} value={def.id}>
                {def.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
