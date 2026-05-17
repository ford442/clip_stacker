import { useEffect, useState } from 'react';
import type { Clip, ExportSettings } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';

interface ClipValues {
  title: string;
  trimStart: string;
  trimEnd: string;
  videoFadeIn: string;
  videoFadeOut: string;
  audioFadeIn: string;
  audioFadeOut: string;
}

interface Props {
  clip: Clip | null;
  exportSettings: ExportSettings;
  onChange: (values: ClipValues) => void;
  onExportSettingsChange: (settings: ExportSettings) => void;
}

type Tab = 'clip' | 'export';

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

export function Inspector({ clip, exportSettings, onChange, onExportSettingsChange }: Props) {
  const [tab, setTab] = useState<Tab>('clip');
  const [values, setValues] = useState<ClipValues>({
    title: '',
    trimStart: '0',
    trimEnd: '',
    videoFadeIn: '0',
    videoFadeOut: '0',
    audioFadeIn: '0',
    audioFadeOut: '0',
  });

  useEffect(() => {
    if (!clip) return;
    setValues({
      title: clip.title,
      trimStart: String(clip.trimStart),
      trimEnd: Number.isFinite(clip.trimEnd) ? String(clip.trimEnd) : '',
      videoFadeIn: String(clip.videoFadeIn),
      videoFadeOut: String(clip.videoFadeOut),
      audioFadeIn: String(clip.audioFadeIn),
      audioFadeOut: String(clip.audioFadeOut),
    });
  }, [clip]);

  const update = (field: keyof ClipValues, value: string) => {
    const next = { ...values, [field]: value };
    setValues(next);
    onChange(next);
  };

  const updateExport = (field: keyof ExportSettings, value: string | number) => {
    onExportSettingsChange({ ...exportSettings, [field]: value });
  };

  const renderClipTab = () => {
    if (!clip) {
      return <div className="muted">Select a clip to edit trim and fades.</div>;
    }
    return (
      <div className="inspector-fields">
        <label>
          Clip title
          <input type="text" value={values.title} onChange={(e) => update('title', e.target.value)} />
        </label>
        <label>
          Trim start (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.trimStart}
            onChange={(e) => update('trimStart', e.target.value)}
          />
        </label>
        <label>
          Trim end (s, optional)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.trimEnd}
            onChange={(e) => update('trimEnd', e.target.value)}
          />
        </label>
        <div className="inspector-group-label">Video fades</div>
        <label>
          Fade in (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.videoFadeIn}
            onChange={(e) => update('videoFadeIn', e.target.value)}
          />
        </label>
        <label>
          Fade out (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.videoFadeOut}
            onChange={(e) => update('videoFadeOut', e.target.value)}
          />
        </label>
        <div className="inspector-group-label">Audio fades</div>
        <label>
          Fade in (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.audioFadeIn}
            onChange={(e) => update('audioFadeIn', e.target.value)}
          />
        </label>
        <label>
          Fade out (s)
          <input
            type="number"
            min="0"
            step="0.1"
            value={values.audioFadeOut}
            onChange={(e) => update('audioFadeOut', e.target.value)}
          />
        </label>
      </div>
    );
  };

  const renderExportTab = () => (
    <div className="inspector-fields">
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

      <div className="inspector-group-label">WebCodecs (GPU path)</div>
      <label title="Target video bitrate for WebCodecs encoder in Mbps">
        Video bitrate ({(exportSettings.videoBitrate / 1_000_000).toFixed(0)} Mbps)
        <input
          type="range"
          min="2000000"
          max="50000000"
          step="1000000"
          value={exportSettings.videoBitrate}
          onChange={(e) => updateExport('videoBitrate', Number(e.target.value))}
        />
      </label>
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

  return (
    <section className="panel inspector-panel">
      <div className="inspector-tabs">
        <button
          type="button"
          className={`inspector-tab${tab === 'clip' ? ' active' : ''}`}
          onClick={() => setTab('clip')}
        >
          Clip
        </button>
        <button
          type="button"
          className={`inspector-tab${tab === 'export' ? ' active' : ''}`}
          onClick={() => setTab('export')}
        >
          Export
        </button>
      </div>

      <div className="inspector-body">
        {tab === 'clip' ? renderClipTab() : renderExportTab()}
      </div>
    </section>
  );
}

export type { ClipValues };
