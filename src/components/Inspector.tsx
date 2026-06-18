import { useEffect, useRef, useState, useMemo, type SyntheticEvent } from 'react';
import type { Clip, ExportSettings } from '../types';
import { DEFAULT_EXPORT_SETTINGS, EXPORT_PRESETS, RESOLUTION_PRESETS, type ResolutionPreset } from '../types';
import { sanitizeFilename } from '../utils/filename';
import { extractThumbnails, MIN_CLIP_DURATION } from '../utils/media';
import { isOverlayOffCanvas } from '../utils/project';
import { extractWaveformPeaks } from '../utils/waveform';
import { clampClipVolume } from '../utils/audioVolume';
import { WaveformCanvas } from './WaveformCanvas';
import { FadeCanvasPreview } from './FadeCanvasPreview';

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
  volume: string;
}

interface Props {
  clip: Clip | null;
  exportSettings: ExportSettings;
  onChange: (values: ClipValues) => void;
  onExportSettingsChange: (settings: ExportSettings) => void;
  onExtractAudio?: () => void;
  onRife?: (mode: 'interpolation' | 'boomerang', multiplier: 2 | 4) => void;
  rifeProcessing?: boolean;
}

type Tab = 'clip' | 'export';

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

const DEFAULT_LAYOUT_VALUES = {
  layerIndex: 0,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  opacity: 1,
  volume: 1,
} as const;
const MIN_INSPECTOR_THUMBNAILS = 4;
const MAX_INSPECTOR_THUMBNAILS = 8;
const SECONDS_PER_INSPECTOR_THUMBNAIL = 3;
const INSPECTOR_WAVEFORM_SAMPLES = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatSeconds(value: number): string {
  return String(Number(value.toFixed(2)));
}

function hasAdvancedLayoutValues(values: Pick<ClipValues, 'layerIndex' | 'x' | 'y' | 'width' | 'height' | 'opacity'>): boolean {
  return (
    parseNumber(values.layerIndex, 0) > DEFAULT_LAYOUT_VALUES.layerIndex ||
    parseNumber(values.x, 0) !== DEFAULT_LAYOUT_VALUES.x ||
    parseNumber(values.y, 0) !== DEFAULT_LAYOUT_VALUES.y ||
    parseNumber(values.width, 0) !== DEFAULT_LAYOUT_VALUES.width ||
    parseNumber(values.height, 0) !== DEFAULT_LAYOUT_VALUES.height ||
    parseNumber(values.opacity, 1) !== DEFAULT_LAYOUT_VALUES.opacity
  );
}

/**
 * Find the preset that matches the given export settings.
 * Returns the preset name if found, otherwise returns 'custom'.
 */
function findMatchingPreset(settings: ExportSettings): string {
  return EXPORT_PRESETS.find(
    p => p.crf === settings.crf && p.preset === settings.preset && p.videoBitrate === settings.videoBitrate
  )?.name || 'custom';
}

export function Inspector({ clip, exportSettings, onChange, onExportSettingsChange, onExtractAudio, onRife, rifeProcessing }: Props) {
  const [tab, setTab] = useState<Tab>('clip');
  const [rifeMultiplier, setRifeMultiplier] = useState<2 | 4>(2);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [thumbMap, setThumbMap] = useState<Record<string, string[]>>({});
  const [waveMap, setWaveMap] = useState<Record<string, Float32Array>>({});
  const generatingThumbs = useRef<Set<string>>(new Set());
  const completedThumbs = useRef<Set<string>>(new Set());
  const generatingWaves = useRef<Set<string>>(new Set());
  const completedWaves = useRef<Set<string>>(new Set());
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
    volume: '1',
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
      volume: String(clip.volume ?? 1),
    });
    setAdvancedOpen(
      hasAdvancedLayoutValues({
        layerIndex: String(clip.layerIndex ?? 0),
        x: String(clip.x ?? 0),
        y: String(clip.y ?? 0),
        width: String(clip.width ?? 0),
        height: String(clip.height ?? 0),
        opacity: String(clip.opacity ?? 1),
      }),
    );
  }, [clip]);

  useEffect(() => {
    if (!clip) return;
    if (clip.kind === 'video') {
      if (completedThumbs.current.has(clip.id) || generatingThumbs.current.has(clip.id)) return;
      generatingThumbs.current.add(clip.id);
      const count = Math.max(
        MIN_INSPECTOR_THUMBNAILS,
        Math.min(MAX_INSPECTOR_THUMBNAILS, Math.ceil(clip.duration / SECONDS_PER_INSPECTOR_THUMBNAIL)),
      );
      extractThumbnails(clip.objectUrl, clip.duration, 0, clip.duration, count).then((thumbs) => {
        generatingThumbs.current.delete(clip.id);
        completedThumbs.current.add(clip.id);
        setThumbMap((prev) => ({ ...prev, [clip.id]: thumbs }));
      });
    }

    if (completedWaves.current.has(clip.id) || generatingWaves.current.has(clip.id)) return;
    generatingWaves.current.add(clip.id);
    extractWaveformPeaks(clip.objectUrl, INSPECTOR_WAVEFORM_SAMPLES).then(
      (peaks) => {
        generatingWaves.current.delete(clip.id);
        completedWaves.current.add(clip.id);
        setWaveMap((prev) => ({ ...prev, [clip.id]: peaks }));
      },
      (error) => {
        generatingWaves.current.delete(clip.id);
        completedWaves.current.add(clip.id);
        console.warn(`Could not extract waveform for clip "${clip.title}" (${clip.id}).`, error);
      },
    );
  }, [clip]);

  const applyValues = (patch: Partial<ClipValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    onChange(next);
  };

  const update = (field: keyof ClipValues, value: string) => {
    applyValues({ [field]: value } as Partial<ClipValues>);
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

  const updateResolutionPreset = (preset: ResolutionPreset) => {
    const nextResolution =
      preset === 'original'
        ? 'original'
        : preset === 'custom'
        ? exportSettings.outputResolution === 'original'
          ? RESOLUTION_PRESETS['720p']
          : exportSettings.outputResolution
        : RESOLUTION_PRESETS[preset];

    onExportSettingsChange({
      ...exportSettings,
      outputResolution: nextResolution,
      resolutionPreset: preset,
    });
  };

  const currentPresetName = useMemo(() => {
    return findMatchingPreset(exportSettings);
  }, [exportSettings]);

  const hasAdvancedLayout = useMemo(() => hasAdvancedLayoutValues(values), [values]);
  const overlayOffCanvas = useMemo(
    () =>
      parseNumber(values.layerIndex, 0) > 0 &&
      isOverlayOffCanvas({
        x: parseNumber(values.x, 0),
        y: parseNumber(values.y, 0),
        width: parseNumber(values.width, 0),
        height: parseNumber(values.height, 0),
      }),
    [values],
  );
  const trimDuration = clip ? Math.max(MIN_CLIP_DURATION, clip.duration) : MIN_CLIP_DURATION;
  const trimStart = clip ? clamp(parseNumber(values.trimStart, 0), 0, Math.max(0, trimDuration - MIN_CLIP_DURATION)) : 0;
  const trimEnd = clip
    ? clamp(values.trimEnd === '' ? trimDuration : parseNumber(values.trimEnd, trimDuration), trimStart + MIN_CLIP_DURATION, trimDuration)
    : trimDuration;
  const clipPreviewDuration = Math.max(MIN_CLIP_DURATION, trimEnd - trimStart);
  const trimStartPct = (trimStart / trimDuration) * 100;
  const trimEndPct = (trimEnd / trimDuration) * 100;
  const currentThumbs = clip ? thumbMap[clip.id] : undefined;
  const currentWave = clip ? waveMap[clip.id] : undefined;
  const volumeValue = clampClipVolume(parseNumber(values.volume, 1));
  const volumePercent = Math.round(volumeValue * 100);

  const updateTrimStart = (nextStart: number) => {
    if (!clip) return;
    const clampedStart = clamp(nextStart, 0, Math.max(0, trimEnd - MIN_CLIP_DURATION));
    applyValues({ trimStart: formatSeconds(clampedStart) });
  };

  const updateTrimEnd = (nextEnd: number) => {
    if (!clip) return;
    const clampedEnd = clamp(nextEnd, trimStart + MIN_CLIP_DURATION, trimDuration);
    applyValues({ trimEnd: clampedEnd >= trimDuration - 0.005 ? '' : formatSeconds(clampedEnd) });
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
        <div className="inspector-group-label">Trim</div>
        <div className="inspector-trim-visual-group">
          <div className="inspector-trim-visual">
            {clip.kind === 'video' ? (
              <div className={`timeline-thumbs inspector-trim-media${currentThumbs ? '' : ' is-loading'}`}>
                {currentThumbs?.map((src, index) => <img key={index} src={src} alt="" />) ?? null}
              </div>
            ) : (
              <div className={`timeline-waveform inspector-trim-media${currentWave ? '' : ' is-loading'}`}>
                {currentWave ? <WaveformCanvas peaks={currentWave} height={54} /> : <span className="waveform-loading-icon">♫</span>}
              </div>
            )}
            <div className="inspector-trim-mask" style={{ width: `${trimStartPct}%` }} />
            <div className="inspector-trim-mask inspector-trim-mask--right" style={{ width: `${100 - trimEndPct}%` }} />
            <div
              className="inspector-trim-window"
              style={{ left: `${trimStartPct}%`, width: `${Math.max(0, trimEndPct - trimStartPct)}%` }}
            />
          </div>
          <div className="inspector-trim-sliders">
            <label className="inspector-trim-slider">
              Start {trimStart.toFixed(2)}s
              <input
                type="range"
                min="0"
                max={Math.max(0, trimDuration - MIN_CLIP_DURATION)}
                step="0.01"
                value={trimStart}
                onChange={(e) => updateTrimStart(Number(e.target.value))}
              />
            </label>
            <label className="inspector-trim-slider">
              End {trimEnd.toFixed(2)}s
              <input
                type="range"
                min={MIN_CLIP_DURATION}
                max={trimDuration}
                step="0.01"
                value={trimEnd}
                onChange={(e) => updateTrimEnd(Number(e.target.value))}
              />
            </label>
          </div>
          <p className="inspector-hint">
            Drag the trim sliders to align with the preview strip for precise trimming.
          </p>
        </div>
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
        <div className="inspector-field-with-preview">
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
          {clip.kind === 'video' ? (
            <FadeCanvasPreview
              objectUrl={clip.objectUrl}
              trimStart={trimStart}
              trimEnd={trimEnd}
              clipDuration={trimDuration}
              fadeDuration={clamp(parseNumber(values.videoFadeIn, 0), 0, clipPreviewDuration / 2)}
              direction="in"
              tone="video"
            />
          ) : (
            <FadeCanvasPreview
              trimStart={trimStart}
              trimEnd={trimEnd}
              clipDuration={trimDuration}
              fadeDuration={clamp(parseNumber(values.videoFadeIn, 0), 0, clipPreviewDuration / 2)}
              direction="in"
              tone="video"
            />
          )}
        </div>
        <div className="inspector-field-with-preview">
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
          {clip.kind === 'video' ? (
            <FadeCanvasPreview
              objectUrl={clip.objectUrl}
              trimStart={trimStart}
              trimEnd={trimEnd}
              clipDuration={trimDuration}
              fadeDuration={clamp(parseNumber(values.videoFadeOut, 0), 0, clipPreviewDuration / 2)}
              direction="out"
              tone="video"
            />
          ) : (
            <FadeCanvasPreview
              trimStart={trimStart}
              trimEnd={trimEnd}
              clipDuration={trimDuration}
              fadeDuration={clamp(parseNumber(values.videoFadeOut, 0), 0, clipPreviewDuration / 2)}
              direction="out"
              tone="video"
            />
          )}
        </div>
        <div className="inspector-group-label">Audio fades</div>
        <div className="inspector-field-with-preview">
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
          <FadeCanvasPreview
            peaks={currentWave}
            trimStart={trimStart}
            trimEnd={trimEnd}
            clipDuration={trimDuration}
            fadeDuration={clamp(parseNumber(values.audioFadeIn, 0), 0, clipPreviewDuration / 2)}
            direction="in"
            tone="audio"
          />
        </div>
        <div className="inspector-field-with-preview">
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
          <FadeCanvasPreview
            peaks={currentWave}
            trimStart={trimStart}
            trimEnd={trimEnd}
            clipDuration={trimDuration}
            fadeDuration={clamp(parseNumber(values.audioFadeOut, 0), 0, clipPreviewDuration / 2)}
            direction="out"
            tone="audio"
          />
        </div>
        <div className="inspector-group-label">Volume</div>
        <div className="inspector-volume-group">
          <div className={`inspector-volume-waveform${currentWave ? '' : ' is-loading'}`}>
            {currentWave ? (
              <WaveformCanvas peaks={currentWave} height={40} />
            ) : (
              <span className="waveform-loading-icon">♫</span>
            )}
          </div>
          <label className="inspector-volume-slider" title="Clip volume from 0% (muted) to 200% (double). Applied during render and preview.">
            Volume {volumePercent}%
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={volumeValue}
              onChange={(e) => update('volume', e.target.value)}
            />
          </label>
          <label
            className="inspector-checkbox-label"
            title="Mute this clip's audio entirely."
          >
            <input
              type="checkbox"
              checked={volumeValue <= 0}
              onChange={(e) => update('volume', e.target.checked ? '0' : '1')}
            />
            Mute clip audio
          </label>
          <p className="inspector-hint">
            Volume is baked into the final render via FFmpeg and reflected in preview playback.
          </p>
        </div>
        {onExtractAudio && (
          <div className="inspector-group-label" style={{ marginTop: '0.75rem' }}>Audio extraction</div>
        )}
        {onExtractAudio && (
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: '0.25rem' }}
            onClick={onExtractAudio}
            title={
              clip.kind === 'audio'
                ? 'Convert this audio clip to a WAV file (PCM 44.1 kHz stereo). If a remote storage endpoint is configured, the WAV will also be uploaded there.'
                : 'Extract audio from this video clip to a WAV file. If a remote storage endpoint is configured, the WAV will also be uploaded there.'
            }
          >
            🎵 Extract Audio to WAV
          </button>
        )}
        {clip.remoteAudioUrl && (
          <div className="muted" style={{ fontSize: '0.75rem', marginTop: '0.25rem', wordBreak: 'break-all' }}>
            Remote WAV: <a href={clip.remoteAudioUrl} target="_blank" rel="noreferrer">{clip.remoteAudioUrl}</a>
          </div>
        )}
        {clip.kind === 'video' && onRife && (
          <>
            <div className="inspector-group-label" style={{ marginTop: '0.75rem' }}>Frame interpolation (RIFE)</div>
            {clip.rifeProcessed && (
              <div className="rife-badge" style={{ marginBottom: '0.5rem' }}>
                {clip.rifeMode === 'boomerang' ? '🔁 Boomerang' : `✨ RIFE ${clip.rifeMultiplier ?? 2}×`}
                {clip.processedFps ? ` · ${clip.processedFps.toFixed(1)} fps` : ''}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
              <label style={{ margin: 0 }}>
                Multiplier
                <select
                  value={rifeMultiplier}
                  onChange={(e) => setRifeMultiplier(Number(e.target.value) as 2 | 4)}
                  style={{ marginLeft: '0.4rem' }}
                  disabled={rifeProcessing}
                >
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onRife('interpolation', rifeMultiplier)}
                disabled={rifeProcessing}
                title={`Apply RIFE ${rifeMultiplier}× frame interpolation to this clip (per-clip, before merging)`}
              >
                {rifeProcessing ? '⏳ Processing…' : `✨ Smoother (${rifeMultiplier}×)`}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onRife('boomerang', rifeMultiplier)}
                disabled={rifeProcessing}
                title="Apply Boomerang (loop forward+reverse) with RIFE frame interpolation"
              >
                {rifeProcessing ? '⏳ Processing…' : '🔁 Boomerang'}
              </button>
            </div>
            <p className="inspector-hint">
              RIFE processes this clip individually (after trim, before merge) to avoid
              artifacts across scene cuts. The clip in the library will be replaced with
              the processed version.
            </p>
          </>
        )}
        {clip.kind === 'video' && (
          <details
            className="inspector-disclosure"
            open={hasAdvancedLayout || advancedOpen}
            onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => {
              if (hasAdvancedLayout) return;
              setAdvancedOpen(e.currentTarget.open);
            }}
          >
            <summary>Advanced layout (PiP){hasAdvancedLayout ? ' • active' : ''}</summary>
            <div className="inspector-disclosure-content">
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
              {overlayOffCanvas && (
                <p className="inspector-warning">
                  ⚠ This overlay is positioned fully off-canvas and won't be visible in the
                  render. Adjust the X/Y offsets so it overlaps the canvas.
                </p>
              )}
              {parseNumber(values.layerIndex, 0) > 0 && (
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
              )}
              {parseNumber(values.layerIndex, 0) === 0 &&
                parseNumber(values.opacity, 1) !== DEFAULT_LAYOUT_VALUES.opacity && (
                  <p className="inspector-hint">
                    Opacity only applies to overlay layers (layer index 1+) and is ignored for the
                    base layer.
                  </p>
                )}
            </div>
          </details>
        )}
      </div>
    );
  };

  const renderExportTab = () => (
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
