import { useRef } from 'react';
import {
  DEFAULT_SECONDARY_COLOR,
  type SecondaryColorPass,
  type SecondaryGrade,
} from '../utils/finishing';
import {
  MAX_SECONDARY_GRADES,
  SECONDARY_GRADE_PRESETS,
  createSecondaryGrade,
  createSecondaryGradeFromPreset,
  type SecondaryMaskType,
} from '../utils/secondaryColor';

interface Props {
  settings: SecondaryColorPass;
  onChange: (settings: SecondaryColorPass) => void;
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

const MASK_OPTIONS: Array<{ value: SecondaryMaskType; label: string }> = [
  { value: 'hue', label: 'Hue' },
  { value: 'window', label: 'Window' },
  { value: 'hue+window', label: 'Hue + window' },
];

function GradeEditor({
  grade,
  index,
  onChange,
  onRemove,
}: {
  grade: SecondaryGrade;
  index: number;
  onChange: (next: SecondaryGrade) => void;
  onRemove: () => void;
}) {
  const patch = (partial: Partial<SecondaryGrade>) => onChange({ ...grade, ...partial });
  const showHue = grade.maskType === 'hue' || grade.maskType === 'hue+window';
  const showWindow = grade.maskType === 'window' || grade.maskType === 'hue+window';

  return (
    <div className="secondary-grade-card">
      <div className="secondary-grade-header">
        <label className="finishing-pass-toggle" title={`Enable grade ${index + 1}`}>
          <input
            type="checkbox"
            checked={grade.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Grade {index + 1}
        </label>
        <button
          type="button"
          className="btn-secondary secondary-grade-remove-btn"
          onClick={onRemove}
          title="Remove this secondary grade"
        >
          Remove
        </button>
      </div>

      <label title="How this grade selects pixels">
        Mask
        <select
          value={grade.maskType}
          onChange={(e) => patch({ maskType: e.target.value as SecondaryMaskType })}
        >
          {MASK_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="finishing-pass-toggle" title="Adjust outside the mask instead of inside">
        <input
          type="checkbox"
          checked={Boolean(grade.invertMask)}
          onChange={(e) => patch({ invertMask: e.target.checked })}
        />
        Invert mask
      </label>

      {showHue && (
        <>
          <div className="secondary-color-group-label">Hue qualifier</div>
          <SliderRow
            label="Hue center"
            title="Center of the hue band (0–360°)"
            min={0}
            max={360}
            step={1}
            value={grade.hueCenter}
            display={`${Math.round(grade.hueCenter)}°`}
            onValue={(hueCenter) => patch({ hueCenter })}
          />
          <SliderRow
            label="Hue width"
            title="Width of the selected hue band"
            min={0}
            max={360}
            step={1}
            value={grade.hueWidth}
            display={`${Math.round(grade.hueWidth)}°`}
            onValue={(hueWidth) => patch({ hueWidth })}
          />
          <SliderRow
            label="Hue softness"
            title="Soft falloff at band edges"
            min={0}
            max={180}
            step={1}
            value={grade.hueSoftness}
            display={`${Math.round(grade.hueSoftness)}°`}
            onValue={(hueSoftness) => patch({ hueSoftness })}
          />
        </>
      )}

      {showWindow && (
        <>
          <div className="secondary-color-group-label">Power window</div>
          <p className="inspector-hint">
            Normalized ellipse — drag-on-preview placement is planned separately.
          </p>
          <SliderRow
            label="Center X"
            title="Window center X (0–1)"
            min={0}
            max={1}
            step={0.01}
            value={grade.windowCenterX}
            display={grade.windowCenterX.toFixed(2)}
            onValue={(windowCenterX) => patch({ windowCenterX })}
          />
          <SliderRow
            label="Center Y"
            title="Window center Y (0–1)"
            min={0}
            max={1}
            step={0.01}
            value={grade.windowCenterY}
            display={grade.windowCenterY.toFixed(2)}
            onValue={(windowCenterY) => patch({ windowCenterY })}
          />
          <SliderRow
            label="Width"
            title="Normalized ellipse width"
            min={0.05}
            max={1}
            step={0.01}
            value={grade.windowWidth}
            display={grade.windowWidth.toFixed(2)}
            onValue={(windowWidth) => patch({ windowWidth })}
          />
          <SliderRow
            label="Height"
            title="Normalized ellipse height"
            min={0.05}
            max={1}
            step={0.01}
            value={grade.windowHeight}
            display={grade.windowHeight.toFixed(2)}
            onValue={(windowHeight) => patch({ windowHeight })}
          />
          <SliderRow
            label="Rotation"
            title="Window rotation in degrees"
            min={-180}
            max={180}
            step={1}
            value={grade.windowRotation}
            display={`${Math.round(grade.windowRotation)}°`}
            onValue={(windowRotation) => patch({ windowRotation })}
          />
          <SliderRow
            label="Feather"
            title="Soft edge as fraction of ellipse radius"
            min={0}
            max={1}
            step={0.01}
            value={grade.windowFeather}
            display={grade.windowFeather.toFixed(2)}
            onValue={(windowFeather) => patch({ windowFeather })}
          />
        </>
      )}

      <div className="secondary-color-group-label">Adjustments</div>
      <SliderRow
        label="Hue shift"
        title="Rotate hue inside the mask (−180 … 180°)"
        min={-180}
        max={180}
        step={1}
        value={grade.hueShift}
        display={`${formatSigned(grade.hueShift, 0)}°`}
        onValue={(hueShift) => patch({ hueShift })}
      />
      <SliderRow
        label="Sat scale"
        title="Saturation multiply (1 = neutral)"
        min={0}
        max={3}
        step={0.01}
        value={grade.satScale}
        display={grade.satScale.toFixed(2)}
        onValue={(satScale) => patch({ satScale })}
      />
      <SliderRow
        label="Sat offset"
        title="Saturation add (−1 … 1)"
        min={-1}
        max={1}
        step={0.01}
        value={grade.satOffset}
        display={formatSigned(grade.satOffset)}
        onValue={(satOffset) => patch({ satOffset })}
      />
      <SliderRow
        label="Lum offset"
        title="Luminance add (−1 … 1)"
        min={-1}
        max={1}
        step={0.01}
        value={grade.lumOffset}
        display={formatSigned(grade.lumOffset)}
        onValue={(lumOffset) => patch({ lumOffset })}
      />
    </div>
  );
}

export function SecondaryColorPanel({ settings, onChange }: Props) {
  const prevAmountRef = useRef(settings.amount ?? 1);
  const patch = (partial: Partial<SecondaryColorPass>) =>
    onChange({ ...settings, ...partial });

  const grades = settings.grades ?? [];
  const showingBefore = settings.enabled && (settings.amount ?? 1) <= 0;
  const canAdd = grades.length < MAX_SECONDARY_GRADES;

  const updateGrade = (index: number, next: SecondaryGrade) => {
    const nextGrades = grades.map((g, i) => (i === index ? next : g));
    patch({ grades: nextGrades });
  };

  const removeGrade = (index: number) => {
    patch({ grades: grades.filter((_, i) => i !== index) });
  };

  const addGrade = (partial?: Partial<SecondaryGrade>) => {
    if (!canAdd) return;
    patch({
      enabled: true,
      grades: [...grades, createSecondaryGrade(partial)],
    });
  };

  const addPreset = (presetId: string) => {
    if (!canAdd) return;
    patch({
      enabled: true,
      grades: [...grades, createSecondaryGradeFromPreset(presetId)],
    });
  };

  return (
    <div className="secondary-color-panel">
      <div className="inspector-group-label">Secondary color</div>
      <p className="inspector-hint">
        Selective hue / window grades after primary balance — up to{' '}
        {MAX_SECONDARY_GRADES} stacked. WebGPU preview and GPU export are
        WYSIWYG. FFmpeg applies hue-only grades via a baked lut3d (windows
        skipped). Canvas2D is ungraded.
      </p>

      <div className="secondary-color-toolbar">
        <label className="finishing-pass-toggle" title="Enable secondary color correction">
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
            title="Bypass secondary only for before/after compare"
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
          className="btn-secondary secondary-color-reset-btn"
          onClick={() =>
            onChange({
              ...DEFAULT_SECONDARY_COLOR,
              enabled: settings.enabled,
              amount: settings.amount ?? 1,
              grades: [],
            })
          }
        >
          Clear grades
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

          <div className="secondary-preset-row">
            <span className="secondary-color-group-label">Presets</span>
            <div className="secondary-preset-chips">
              {SECONDARY_GRADE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="btn-secondary secondary-preset-chip"
                  title={preset.description}
                  disabled={!canAdd}
                  onClick={() => addPreset(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {grades.map((grade, index) => (
            <GradeEditor
              key={index}
              grade={grade}
              index={index}
              onChange={(next) => updateGrade(index, next)}
              onRemove={() => removeGrade(index)}
            />
          ))}

          {canAdd ? (
            <button
              type="button"
              className="btn-secondary secondary-add-grade-btn"
              onClick={() => addGrade()}
            >
              Add grade ({grades.length}/{MAX_SECONDARY_GRADES})
            </button>
          ) : (
            <p className="inspector-hint">Maximum of {MAX_SECONDARY_GRADES} grades.</p>
          )}
        </>
      )}
    </div>
  );
}
