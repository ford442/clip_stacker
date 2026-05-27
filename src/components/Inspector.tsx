import { useEffect, useRef, useState } from 'react';
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
  // PiP / compositing layout
  layerIndex: string;
  x: string;
  y: string;
  width: string;
  height: string;
  opacity: string;
}

interface Props {
  clip: Clip | null;
  exportSettings: ExportSettings;
  onChange: (values: ClipValues) => void;
  onExportSettingsChange: (settings: ExportSettings) => void;
  onExtractAudio?: () => void;
}

type Tab = 'clip' | 'export';

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

export function Inspector({ clip, exportSettings, onChange, onExportSettingsChange, onExtractAudio }: Props) {
  const [tab, setTab] = useState<Tab>('clip');
  const inspectorRef = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<ClipValues>({
    title: '',
    trimStart: '0',
    trimEnd: '',
    videoFadeIn: '0',
    videoFadeOut: '0',
    audioFadeIn: '0',
    audioFadeOut: '0',
    layerIndex: '0',
    x: '0',
    y: '0',
    width: '0',
    height: '0',
    opacity: '1',
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
      layerIndex: String(clip.layerIndex ?? 0),
      x: String(clip.x ?? 0),
      y: String(clip.y ?? 0),
      width: String(clip.width ?? 0),
      height: String(clip.height ?? 0),
      opacity: String(clip.opacity ?? 1),
    });
  }, [clip]);

  // Keyboard support: Tab to toggle between inspector tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Tab' || e.key === 'ArrowRight') && inspectorRef.current?.contains(document.activeElement as Node)) {
        const tabButtons = inspectorRef.current?.querySelectorAll('.inspector-tab');
        if (tabButtons && tabButtons.length > 0) {
          // Toggle between tabs when Tab or Arrow Right is pressed
          const newTab = tab === 'clip' ? 'export' : 'clip';
          if (e.key === 'Tab') {
            // For Tab, optionally handle it
            const isLastTab = document.activeElement === tabButtons[tabButtons.length - 1];
            if (isLastTab && !e.shiftKey) {
              e.preventDefault();
              setTab(newTab);
              (tabButtons[0] as HTMLElement).focus();
            }
          }
        }
      }
    };
    const panel = inspectorRef.current;
    if (panel) {
      panel.addEventListener('keydown', handleKeyDown);
      return () => panel.removeEventListener('keydown', handleKeyDown);
    }
  }, [tab]);

  const update = (field: keyof ClipValues, value: string) => {
    const next = { ...values, [field]: value };
    setValues(next);
    onChange(next);
  };

  /** Nudge a numeric field by `delta` seconds, clamped to ≥ 0. */
  const nudge = (field: 'trimStart' | 'trimEnd', delta: number) => {
    const current = parseFloat(values[field]) || 0;
    const next = Math.max(0, parseFloat((current + delta).toFixed(3)));
    update(field, String(next));
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
            step="0.01"
            value={values.trimStart}
            onChange={(e) => update('trimStart', e.target.value)}
          />
          <div className="nudge-row">
            <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', -0.5)} title="−0.5 s">−0.5</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', -0.1)} title="−0.1 s">−0.1</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', -0.01)} title="−0.01 s">−0.01</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', +0.01)} title="+0.01 s">+0.01</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', +0.1)} title="+0.1 s">+0.1</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimStart', +0.5)} title="+0.5 s">+0.5</button>
          </div>
        </label>
        <label>
          Trim end (s, optional)
          <input
            type="number"
            min="0"
            step="0.01"
            value={values.trimEnd}
            onChange={(e) => update('trimEnd', e.target.value)}
          />
          <div className="nudge-row">
            <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', -0.5)} title="−0.5 s">−0.5</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', -0.1)} title="−0.1 s">−0.1</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', -0.01)} title="−0.01 s">−0.01</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', +0.01)} title="+0.01 s">+0.01</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', +0.1)} title="+0.1 s">+0.1</button>
            <button type="button" className="nudge-btn" onClick={() => nudge('trimEnd', +0.5)} title="+0.5 s">+0.5</button>
          </div>
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
        {clip.kind === 'video' && onExtractAudio && (
          <div className="inspector-group-label" style={{ marginTop: '0.75rem' }}>Audio extraction</div>
        )}
        {clip.kind === 'video' && onExtractAudio && (
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: '0.25rem' }}
            onClick={onExtractAudio}
            title="Extract audio from this video clip to a WAV file. If a remote storage endpoint is configured, the WAV will also be uploaded there."
          >
            🎵 Extract Audio to WAV
          </button>
        )}
        {clip.remoteAudioUrl && (
          <div className="muted" style={{ fontSize: '0.75rem', marginTop: '0.25rem', wordBreak: 'break-all' }}>
            Remote WAV: <a href={clip.remoteAudioUrl} target="_blank" rel="noreferrer">{clip.remoteAudioUrl}</a>
          </div>
        )}
        {clip.kind === 'video' && (
          <>
            <div className="inspector-group-label" style={{ marginTop: '0.75rem' }}>Picture-in-Picture</div>
            <label title="0 = base layer (sequential concatenation). 1 or higher = overlay on top of the base video.">
              Layer index
              <input
                type="number"
                min="0"
                step="1"
                value={values.layerIndex}
                onChange={(e) => update('layerIndex', e.target.value)}
              />
            </label>
            {Number(values.layerIndex) > 0 && (
              <>
                <label title="Horizontal position of the overlay in pixels from the left edge of the canvas.">
                  X offset (px)
                  <input
                    type="number"
                    step="1"
                    value={values.x}
                    onChange={(e) => update('x', e.target.value)}
                  />
                </label>
                <label title="Vertical position of the overlay in pixels from the top edge of the canvas.">
                  Y offset (px)
                  <input
                    type="number"
                    step="1"
                    value={values.y}
                    onChange={(e) => update('y', e.target.value)}
                  />
                </label>
                <label title="Width of the overlay in pixels. Enter 0 to keep the clip's original width.">
                  Width (px, 0=auto)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={values.width}
                    onChange={(e) => update('width', e.target.value)}
                  />
                </label>
                <label title="Height of the overlay in pixels. Enter 0 to keep the clip's original height.">
                  Height (px, 0=auto)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={values.height}
                    onChange={(e) => update('height', e.target.value)}
                  />
                </label>
                <label title="Opacity of the overlay from 0.0 (transparent) to 1.0 (fully opaque).">
                  Opacity (0–1)
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={values.opacity}
                    onChange={(e) => update('opacity', e.target.value)}
                  />
                </label>
              </>
            )}
          </>
        )}
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
    <section className="panel inspector-panel" ref={inspectorRef}>
      <div className="inspector-tabs">
        <button
          type="button"
          className={`inspector-tab${tab === 'clip' ? ' active' : ''}`}
          onClick={() => setTab('clip')}
          aria-label="Clip tab"
          aria-selected={tab === 'clip'}
          role="tab"
        >
          Clip
        </button>
        <button
          type="button"
          className={`inspector-tab${tab === 'export' ? ' active' : ''}`}
          onClick={() => setTab('export')}
          aria-label="Export tab"
          aria-selected={tab === 'export'}
          role="tab"
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
