import { DEFAULT_EXPORT_SETTINGS, EXPORT_PRESETS, RESOLUTION_PRESETS, type ExportSettings, type ResolutionPreset } from '../../types';
import { sanitizeFilename } from '../../utils/filename';
import type { FinishingSettings } from '../../utils/finishing';
import { FinishingPanel } from '../FinishingPanel';
import { PRESETS } from './helpers';

interface InspectorExportTabProps {
  exportSettings: ExportSettings;
  finishing: FinishingSettings | undefined;
  currentPresetName: string;
  onExportSettingsChange: (settings: ExportSettings) => void;
  onFinishingChange: ((settings: FinishingSettings) => void) | undefined;
  updateExport: (field: keyof ExportSettings, value: string | number) => void;
  updateResolutionPreset: (preset: ResolutionPreset) => void;
}

export function InspectorExportTab({
  exportSettings,
  finishing,
  currentPresetName,
  onExportSettingsChange,
  onFinishingChange,
  updateExport,
  updateResolutionPreset,
}: InspectorExportTabProps) {
  return (
    <div className="inspector-fields">
      <div className="inspector-group-label">Output filename</div>
      <label title="Output filename (without .mp4 extension)">
        Filename
        <input
          type="text"
          value={exportSettings.filename}
          onChange={(e) => updateExport('filename', e.target.value)}
          placeholder="stacked"
        />
      </label>
      <p className="inspector-hint">
        {sanitizeFilename(exportSettings.filename)}
      </p>

      <div className="inspector-group-label">Output resolution</div>
      <label title="Choose the render canvas size. Original preserves the existing auto/lossless path when possible.">
        Resolution
        <select
          value={exportSettings.resolutionPreset ?? 'custom'}
          onChange={(e) => updateResolutionPreset(e.target.value as ResolutionPreset)}
        >
          <option value="original">Original / auto</option>
          <option value="720p">720p (1280x720)</option>
          <option value="1080p">1080p (1920x1080)</option>
          <option value="1440p">1440p (2560x1440)</option>
          <option value="4k">4K (3840x2160)</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {(exportSettings.resolutionPreset ?? 'custom') === 'custom' && (
        <label title="Use WIDTHxHEIGHT, for example 1080x1920 for vertical output. Odd values are rounded down for H.264 compatibility.">
          Custom size
          <input
            type="text"
            value={exportSettings.outputResolution}
            onChange={(e) => onExportSettingsChange({
              ...exportSettings,
              outputResolution: e.target.value,
              resolutionPreset: 'custom',
            })}
            placeholder="1280x720"
          />
        </label>
      )}

      <div className="inspector-group-label">Quality preset</div>
      <label>
        Preset
        <select
          value={currentPresetName}
          onChange={(e) => {
            if (e.target.value === 'custom') return;
            const preset = EXPORT_PRESETS.find(p => p.name === e.target.value);
            if (preset) {
              onExportSettingsChange({
                ...exportSettings,
                crf: preset.crf,
                preset: preset.preset,
                videoBitrate: preset.videoBitrate,
              });
            }
          }}
        >
          {EXPORT_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>{p.label}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>

      <div className="inspector-group-label">FFmpeg quality</div>
      <label title="Constant Rate Factor: 0 = lossless, 51 = worst. Recommended: 15–25.">
        CRF ({exportSettings.crf})
        <input
          type="range"
          min="0"
          max="51"
          step="1"
          value={exportSettings.crf}
          onChange={(e) => updateExport('crf', Number(e.target.value))}
        />
      </label>
      <label>
        Preset
        <select
          value={exportSettings.preset}
          onChange={(e) => updateExport('preset', e.target.value)}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>
      <p className="inspector-hint">
        Lower CRF = better quality, larger file.<br />
        Faster preset = quicker encode, slightly larger file.
      </p>

      {finishing && onFinishingChange && (
        <FinishingPanel settings={finishing} onChange={onFinishingChange} />
      )}

      <div className="inspector-group-label">WebCodecs (GPU path)</div>
      <label title="Hardware encoder codec. HEVC/AV1 fall back to H.264 when unsupported.">
        Video codec
        <select
          value={exportSettings.videoCodec ?? 'h264'}
          onChange={(e) =>
            updateExport('videoCodec', e.target.value as NonNullable<ExportSettings['videoCodec']>)
          }
        >
          <option value="h264">H.264 (hardware)</option>
          <option value="hevc">HEVC / H.265</option>
          <option value="av1">AV1</option>
        </select>
      </label>
      <label title="Target video bitrate for WebCodecs encoder. Set to Auto to derive from CRF.">
        Video bitrate (
        {exportSettings.videoBitrate <= 0
          ? 'Auto from CRF'
          : `${(exportSettings.videoBitrate / 1_000_000).toFixed(0)} Mbps`}
        )
        <input
          type="range"
          min="0"
          max="50000000"
          step="1000000"
          value={exportSettings.videoBitrate}
          onChange={(e) => updateExport('videoBitrate', Number(e.target.value))}
        />
      </label>
      <p className="inspector-hint">
        Bitrate 0 = auto from CRF × resolution. Codec choice applies to the GPU export path only.
      </p>
      <button
        type="button"
        className="btn-secondary"
        style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}
        onClick={() => onExportSettingsChange(DEFAULT_EXPORT_SETTINGS)}
      >
        Reset to defaults
      </button>
    </div>
  );
}
