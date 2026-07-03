import { useRef } from 'react';
import {
  BUNDLED_LUT_PRESETS,
  COLOR_LUT_NONE,
  type ColorGradeSettings,
} from '../utils/lut';

interface Props {
  settings: ColorGradeSettings;
  onChange: (settings: ColorGradeSettings) => void;
}

export function ColorGradePicker({ settings, onChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setPreset = (lutId: string) => {
    if (lutId === COLOR_LUT_NONE) {
      onChange({ lutId: COLOR_LUT_NONE, intensity: settings.intensity });
      return;
    }
    onChange({
      lutId,
      intensity: settings.intensity,
    });
  };

  const handleUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      onChange({
        lutId: 'custom',
        intensity: settings.intensity,
        customCubeText: text,
        customFileName: file.name,
      });
    } catch {
      // Caller may surface errors via status if needed.
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const active =
    settings.lutId !== COLOR_LUT_NONE && settings.intensity > 0;

  return (
    <div className="color-grade-picker">
      <div className="inspector-group-label">Color grade (3D LUT)</div>
      <p className="inspector-hint">
        Applies as the final WebGPU pass on preview and GPU export. Canvas2D /
        FFmpeg paths are ungraded.
      </p>

      <label title="Choose a bundled look or upload a custom .cube LUT">
        LUT preset
        <select
          value={
            settings.lutId === 'custom'
              ? 'custom'
              : settings.lutId
          }
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'custom') {
              fileInputRef.current?.click();
              return;
            }
            setPreset(value);
          }}
        >
          <option value={COLOR_LUT_NONE}>None</option>
          {BUNDLED_LUT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value="custom">
            {settings.lutId === 'custom' && settings.customFileName
              ? `Custom: ${settings.customFileName}`
              : 'Upload custom .cube…'}
          </option>
        </select>
      </label>

      <input
        ref={fileInputRef}
        type="file"
        accept=".cube,text/plain"
        className="color-grade-file-input"
        onChange={(e) => void handleUpload(e.target.files?.[0])}
      />

      {settings.lutId === 'custom' && settings.customFileName && (
        <p className="inspector-hint">
          Loaded: <strong>{settings.customFileName}</strong>
        </p>
      )}

      {settings.lutId !== COLOR_LUT_NONE && (
        <>
          <label title="Blend between the original image and the LUT result">
            Intensity ({Math.round(settings.intensity * 100)}%)
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.intensity}
              onChange={(e) =>
                onChange({
                  ...settings,
                  intensity: Number(e.target.value),
                })
              }
            />
          </label>
          {active && (
            <p className="inspector-hint">
              {
                BUNDLED_LUT_PRESETS.find((p) => p.id === settings.lutId)
                  ?.description
              }
            </p>
          )}
        </>
      )}

      <button
        type="button"
        className="btn-secondary color-grade-upload-btn"
        onClick={() => fileInputRef.current?.click()}
      >
        Upload .cube LUT
      </button>
    </div>
  );
}
