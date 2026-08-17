import { memo, useEffect, useRef, useState, useMemo, type SyntheticEvent } from 'react';
import type { Clip, ClipAnimatableProp, ClipKeyframes, ClipAutomation, ExportSettings } from '../types';
import { DEFAULT_EXPORT_SETTINGS, EXPORT_PRESETS, RESOLUTION_PRESETS, type ResolutionPreset } from '../types';
import { resolveClipLocalTimeAtGlobal } from '../utils/previewComposition';
import { usePlayheadTime } from '../hooks/usePlayheadTime';
import {
  useEditorClip,
  useEditorClipGroups,
  useEditorClips,
  useEditorTransitions,
  useSelectedClipId,
} from '../store';
import { sanitizeFilename } from '../utils/filename';
import { extractThumbnails, MIN_CLIP_DURATION } from '../utils/media';
import { formatGpuChoreDiagnostics, gpuComputeAvailable } from '../gpu-chores/diagnostics';
import { getClipDuration, isOverlayOffCanvas } from '../utils/project';
import {
  clipLayoutToDisplayPixels,
  layoutNormToPixelValue,
  layoutPixelToNormValue,
} from '../utils/overlayCoords';
import { extractWaveformPeaks } from '../utils/waveform';
import { clampClipVolume } from '../utils/audioVolume';
import {
  DEFAULT_CLIP_PAN,
  MAX_CLIP_PAN,
  MIN_CLIP_PAN,
} from '../utils/clipAutomation';
import {
  beatsSpannedByDuration,
  clampClipPlaybackRate,
  DEFAULT_CLIP_PLAYBACK_RATE,
  getTrimmedSourceDuration,
  MIN_CLIP_PLAYBACK_RATE,
  MAX_CLIP_PLAYBACK_RATE,
  nudgePlaybackRate,
  outputDurationForRate,
  PLAYBACK_RATE_NUDGE_COARSE,
  PLAYBACK_RATE_NUDGE_FINE,
  playbackRateForTargetDuration,
  playbackRateToFitBeats,
  UI_MAX_CLIP_PLAYBACK_RATE,
} from '../utils/playbackRate';
import { clipHasKeyframes } from '../utils/animatedLayout';
import {
  buildPipRect,
  clipAspectRatio,
  nextOverlayLayerIndex,
  parseCanvasSize,
  type PipCorner,
} from '../utils/pipPreset';
import { WaveformCanvas } from './WaveformCanvas';
import { FadeCanvasPreview } from './FadeCanvasPreview';
import { KeyframeMiniEditor } from './KeyframeMiniEditor';
import { FinishingPanel } from './FinishingPanel';
import type { FinishingSettings } from '../utils/finishing';

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
  playbackRate: string;
}

interface Props {
  exportSettings: ExportSettings;
  onChange: (values: ClipValues) => void;
  onKeyframesChange?: (keyframes: ClipKeyframes | undefined) => void;
  onAutomationChange?: (automation: ClipAutomation | undefined) => void;
  onApplyKenBurns?: () => void;
  onExportSettingsChange: (settings: ExportSettings) => void;
  finishing?: FinishingSettings;
  onFinishingChange?: (settings: FinishingSettings) => void;
  onExtractAudio?: () => void;
  onRife?: (mode: 'interpolation' | 'boomerang', multiplier: 2 | 4) => void;
  rifeProcessing?: boolean;
}

const PIP_KEYFRAME_PROPS: Array<{
  prop: ClipAnimatableProp;
  label: string;
  step: number;
  min?: number;
  max?: number;
  defaultValue: (clip: Clip) => number;
}> = [
  { prop: 'x', label: 'X position', step: 1, defaultValue: (c) => c.x ?? 0 },
  { prop: 'y', label: 'Y position', step: 1, defaultValue: (c) => c.y ?? 0 },
  {
    prop: 'width',
    label: 'Width',
    step: 1,
    min: 0,
    defaultValue: (c) => c.width ?? 0,
  },
  {
    prop: 'height',
    label: 'Height',
    step: 1,
    min: 0,
    defaultValue: (c) => c.height ?? 0,
  },
  { prop: 'opacity', label: 'Opacity', step: 0.05, min: 0, max: 1, defaultValue: (c) => c.opacity ?? 1 },
];

const KEN_BURNS_PROPS: Array<{
  prop: ClipAnimatableProp;
  label: string;
  step: number;
  min?: number;
  max?: number;
  defaultValue: number;
}> = [
  { prop: 'uvScaleX', label: 'Zoom X', step: 0.01, min: 0.1, max: 2, defaultValue: 1 },
  { prop: 'uvScaleY', label: 'Zoom Y', step: 0.01, min: 0.1, max: 2, defaultValue: 1 },
  { prop: 'uvOffsetX', label: 'Pan X', step: 0.01, min: -1, max: 1, defaultValue: 0 },
  { prop: 'uvOffsetY', label: 'Pan Y', step: 0.01, min: -1, max: 1, defaultValue: 0 },
];

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
  playbackRate: 1,
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

function GpuChoreLevelsPanel({ clip }: { clip: Clip }) {
  const bins = clip.lumaHistogram;
  const max = bins && bins.length ? Math.max(...bins, 1) : 1;
  const avail = gpuComputeAvailable();
  return (
    <div className="inspector-gpu-chores">
      <div className="inspector-group-label">Levels (Rec.709 luma)</div>
      {bins && bins.length === 256 ? (
        <div className="luma-histogram" role="img" aria-label="Luminance histogram">
          {bins.map((count, i) => (
            <span
              key={i}
              className="luma-histogram-bar"
              style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
            />
          ))}
        </div>
      ) : (
        <p className="inspector-hint">Analyzing still with gpu-chores…</p>
      )}
      {clip.lumaLevels && (
        <p className="inspector-hint">
          Black {clip.lumaLevels.black} · mean {clip.lumaLevels.mean.toFixed(1)} · white {clip.lumaLevels.white}
        </p>
      )}
      <p className="inspector-hint inspector-gpu-chore-crumb">
        {clip.gpuChoreBackend
          ? `chores: ${clip.gpuChoreBackend} — ${clip.gpuChoreReason}`
          : formatGpuChoreDiagnostics()}
        {' · '}
        gpuComputeAvailable: {avail.available ? 'yes' : 'no'} ({avail.reason})
      </p>
    </div>
  );
}

function InspectorImpl({
  exportSettings,
  onChange,
  onKeyframesChange,
  onAutomationChange,
  onApplyKenBurns,
  onExportSettingsChange,
  finishing,
  onFinishingChange,
  onExtractAudio,
  onRife,
  rifeProcessing,
}: Props) {
  const selectedClipId = useSelectedClipId();
  const clip = useEditorClip(selectedClipId);
  const clips = useEditorClips();
  const clipGroups = useEditorClipGroups();
  const transitions = useEditorTransitions();
  const playheadTime = usePlayheadTime();
  const clipLocalTime = useMemo(() => {
    if (!clip || playheadTime === null) return 0;
    const resolved = resolveClipLocalTimeAtGlobal(clips, clipGroups, transitions, clip.id, playheadTime);
    return resolved?.localTime ?? 0;
  }, [clip, clips, clipGroups, transitions, playheadTime]);
  const [tab, setTab] = useState<Tab>('clip');
  const [rifeMultiplier, setRifeMultiplier] = useState<2 | 4>(2);
  const [activeKeyframeProp, setActiveKeyframeProp] = useState<ClipAnimatableProp>('x');
  const inspectorRef = useRef<HTMLDivElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pipCorner, setPipCorner] = useState<PipCorner>('bottom-right');
  const [fitBeatCount, setFitBeatCount] = useState('8');
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
    playbackRate: '1',
  });

  const layoutCanvas = useMemo(
    () => parseCanvasSize(exportSettings.outputResolution),
    [exportSettings.outputResolution],
  );

  useEffect(() => {
    if (!clip) return;
    const layout = clipLayoutToDisplayPixels(clip, layoutCanvas);
    setValues({
      title: clip.title,
      trimStart: String(clip.trimStart),
      trimEnd: Number.isFinite(clip.trimEnd) ? String(clip.trimEnd) : '',
      videoFadeIn: String(clip.videoFadeIn),
      videoFadeOut: String(clip.videoFadeOut),
      audioFadeIn: String(clip.audioFadeIn),
      audioFadeOut: String(clip.audioFadeOut),
      layerIndex: String(clip.layerIndex ?? 0),
      x: String(layout.x),
      y: String(layout.y),
      width: String(layout.width),
      height: String(layout.height),
      opacity: String(clip.opacity ?? 1),
      volume: String(clip.volume ?? 1),
      playbackRate: String(clip.playbackRate ?? 1),
    });
    setAdvancedOpen(
      hasAdvancedLayoutValues({
        layerIndex: String(clip.layerIndex ?? 0),
        x: String(layout.x),
        y: String(layout.y),
        width: String(layout.width),
        height: String(layout.height),
        opacity: String(clip.opacity ?? 1),
      }),
    );
  }, [clip, layoutCanvas]);

  useEffect(() => {
    if (!clip) return;
    if (clip.kind === 'video') {
      if (clip.stillImage) {
        if (clip.posterUrl) {
          setThumbMap((prev) => ({ ...prev, [clip.id]: [clip.posterUrl!] }));
          completedThumbs.current.add(clip.id);
        }
      } else if (
        !completedThumbs.current.has(clip.id) &&
        !generatingThumbs.current.has(clip.id)
      ) {
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
    }

    if (clip.stillImage && clip.hasAudio === false) return;
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
        x: layoutPixelToNormValue('x', parseNumber(values.x, 0), layoutCanvas),
        y: layoutPixelToNormValue('y', parseNumber(values.y, 0), layoutCanvas),
        width: layoutPixelToNormValue('width', parseNumber(values.width, 0), layoutCanvas),
        height: layoutPixelToNormValue('height', parseNumber(values.height, 0), layoutCanvas),
        videoWidth: clip?.videoWidth,
        videoHeight: clip?.videoHeight,
      }, layoutCanvas.width, layoutCanvas.height),
    [values, layoutCanvas, clip?.videoWidth, clip?.videoHeight],
  );
  const isOverlay = parseNumber(values.layerIndex, 0) > 0;

  /**
   * One-click Picture-in-Picture: promote the clip to the next free overlay layer and
   * drop it into a corner of the canvas at a sensible default size.
   */
  const applyPipPreset = (corner: PipCorner) => {
    if (!clip) return;
    const canvas = parseCanvasSize(exportSettings.outputResolution);
    const rect = buildPipRect(canvas, corner, clipAspectRatio(clip));
    const display = clipLayoutToDisplayPixels(
      {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      canvas,
    );
    const layerIndex = isOverlay
      ? parseNumber(values.layerIndex, 1)
      : nextOverlayLayerIndex(clips, clip.id);
    applyValues({
      layerIndex: String(layerIndex),
      x: String(display.x),
      y: String(display.y),
      width: String(display.width),
      height: String(display.height),
      opacity: parseNumber(values.opacity, 1) === 0 ? '1' : values.opacity,
    });
    setPipCorner(corner);
    setAdvancedOpen(true);
  };

  /** Send the clip back to the base layer and clear the overlay rectangle. */
  const useAsBaseLayer = () => {
    applyValues({
      layerIndex: '0',
      x: '0',
      y: '0',
      width: '0',
      height: '0',
      opacity: '1',
    });
    setAdvancedOpen(false);
  };

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
  const playbackRateValue = clampClipPlaybackRate(
    parseNumber(values.playbackRate, DEFAULT_CLIP_PLAYBACK_RATE),
  );
  const trimmedSourceDuration = clip
    ? getTrimmedSourceDuration({
        trimStart,
        trimEnd,
        duration: clip.duration,
      })
    : MIN_CLIP_DURATION;
  const outputSpeedDuration = outputDurationForRate(
    trimmedSourceDuration,
    playbackRateValue,
  );
  const setPlaybackRate = (rate: number) => {
    update('playbackRate', String(clampClipPlaybackRate(rate)));
  };

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
        {(clip.lumaHistogram || clip.stillImage) && (
          <GpuChoreLevelsPanel clip={clip} />
        )}
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
            Automation lanes override the scalar level over clip-local time; fades still apply on top.
          </p>
        </div>
        <div className="inspector-group-label">Speed / time-stretch</div>
        <div className="inspector-speed-panel">
          <div className="inspector-speed-primary">
            <label
              className="inspector-speed-slider"
              title="Constant playback speed. Higher = shorter on the timeline. Export audio is pitch-preserving."
            >
              <span className="inspector-speed-slider-header">
                <span>Speed</span>
                <strong className="inspector-speed-live-rate" aria-live="polite">
                  {playbackRateValue.toFixed(3)}×
                </strong>
                <span className="inspector-speed-out-duration" aria-live="polite">
                  Out {outputSpeedDuration.toFixed(2)}s
                </span>
              </span>
              <input
                type="range"
                min={MIN_CLIP_PLAYBACK_RATE}
                max={UI_MAX_CLIP_PLAYBACK_RATE}
                step="0.01"
                value={playbackRateValue}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
                aria-valuetext={`${playbackRateValue.toFixed(3)} times, output duration ${outputSpeedDuration.toFixed(2)} seconds`}
              />
            </label>

            <div className="inspector-speed-controls" role="group" aria-label="Playback rate controls">
              <label className="inspector-speed-field" title="Exact playback rate">
                Rate
                <input
                  type="number"
                  min={MIN_CLIP_PLAYBACK_RATE}
                  max={UI_MAX_CLIP_PLAYBACK_RATE}
                  step="0.001"
                  value={Number(playbackRateValue.toFixed(3))}
                  onChange={(e) => setPlaybackRate(Number(e.target.value))}
                  aria-describedby="inspector-speed-out-hint"
                />
              </label>
              <div className="inspector-speed-nudges" role="group" aria-label="Nudge speed">
                <button
                  type="button"
                  className="btn-secondary kf-btn"
                  title={`−${PLAYBACK_RATE_NUDGE_COARSE}×`}
                  onClick={() =>
                    setPlaybackRate(
                      nudgePlaybackRate(playbackRateValue, -PLAYBACK_RATE_NUDGE_COARSE),
                    )
                  }
                >
                  −0.05
                </button>
                <button
                  type="button"
                  className="btn-secondary kf-btn"
                  title={`−${PLAYBACK_RATE_NUDGE_FINE}×`}
                  onClick={() =>
                    setPlaybackRate(
                      nudgePlaybackRate(playbackRateValue, -PLAYBACK_RATE_NUDGE_FINE),
                    )
                  }
                >
                  −0.01
                </button>
                <button
                  type="button"
                  className="btn-secondary kf-btn"
                  title={`+${PLAYBACK_RATE_NUDGE_FINE}×`}
                  onClick={() =>
                    setPlaybackRate(
                      nudgePlaybackRate(playbackRateValue, PLAYBACK_RATE_NUDGE_FINE),
                    )
                  }
                >
                  +0.01
                </button>
                <button
                  type="button"
                  className="btn-secondary kf-btn"
                  title={`+${PLAYBACK_RATE_NUDGE_COARSE}×`}
                  onClick={() =>
                    setPlaybackRate(
                      nudgePlaybackRate(playbackRateValue, PLAYBACK_RATE_NUDGE_COARSE),
                    )
                  }
                >
                  +0.05
                </button>
              </div>
            </div>
          </div>

          <div className="inspector-speed-row">
            <label
              className="inspector-speed-field"
              title="Set the output timeline length; rate is computed from the trimmed source."
            >
              Fit to duration (s)
              <input
                type="number"
                min={MIN_CLIP_DURATION}
                step="0.01"
                value={Number(outputSpeedDuration.toFixed(3))}
                onChange={(e) => {
                  const target = Number(e.target.value);
                  if (!Number.isFinite(target) || target <= 0) return;
                  setPlaybackRate(
                    playbackRateForTargetDuration(trimmedSourceDuration, target),
                  );
                }}
              />
            </label>
            <div id="inspector-speed-out-hint" className="inspector-speed-meta" aria-live="polite">
              <span>Source {trimmedSourceDuration.toFixed(2)}s</span>
              <span>→</span>
              <span>Out {outputSpeedDuration.toFixed(2)}s</span>
            </div>
          </div>

          {clip.bpmEstimate != null && clip.bpmEstimate > 0 && (
            <div className="inspector-speed-row inspector-speed-beats">
              <label
                className="inspector-speed-field"
                title="Stretch/compress so the clip spans exactly this many beats at the clip BPM."
              >
                Fit to beats
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={fitBeatCount}
                  onChange={(e) => setFitBeatCount(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn-secondary kf-btn"
                onClick={() => {
                  const beats = Math.max(1, Math.round(parseNumber(fitBeatCount, 8)));
                  const next = playbackRateToFitBeats(
                    trimmedSourceDuration,
                    clip.bpmEstimate!,
                    beats,
                  );
                  if (next != null) {
                    setFitBeatCount(String(beats));
                    setPlaybackRate(next);
                  }
                }}
              >
                Apply @ {Math.round(clip.bpmEstimate)} BPM
              </button>
              <span className="inspector-speed-meta">
                Now ≈ {beatsSpannedByDuration(outputSpeedDuration, clip.bpmEstimate).toFixed(2)} beats
              </span>
            </div>
          )}

          <div className="inspector-speed-presets">
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((preset) => (
              <button
                key={preset}
                type="button"
                className={`btn-secondary kf-btn${
                  Math.abs(playbackRateValue - preset) < 0.001 ? ' is-active' : ''
                }`}
                onClick={() => setPlaybackRate(preset)}
              >
                {preset}×
              </button>
            ))}
            <button
              type="button"
              className="btn-secondary kf-btn"
              disabled={Math.abs(playbackRateValue - 1) < 1e-6}
              onClick={() => setPlaybackRate(1)}
            >
              Reset 1×
            </button>
          </div>
          <p className="inspector-hint">
            Lip-sync tip: set <em>Fit to duration</em> to the music phrase length, then nudge ±0.01
            while previewing. For cinematic ramps, add a Speed automation curve (Inspector or
            selected timeline clip). Variable remaps keep pitch via WSOLA; constant rate uses
            atempo on export.
          </p>
        </div>
        {onAutomationChange && (
          <details className="inspector-details" open={(clip.automation?.volume?.length ?? 0) > 0 || (clip.automation?.pan?.length ?? 0) > 0 || (clip.automation?.playbackRate?.length ?? 0) > 0}>
            <summary className="inspector-group-label">Audio / speed automation</summary>
            <div className="inspector-fields" style={{ marginTop: '0.5rem' }}>
              <KeyframeMiniEditor
                label="Volume"
                duration={getClipDuration(clip)}
                currentTime={clipLocalTime}
                keyframes={clip.automation?.volume}
                defaultValue={volumeValue}
                min={0}
                max={2}
                step={0.01}
                onChange={(track) => {
                  const next: ClipAutomation = { ...(clip.automation ?? {}) };
                  if (track?.length) next.volume = track;
                  else delete next.volume;
                  onAutomationChange(
                    Object.keys(next).length > 0 ? next : undefined,
                  );
                }}
              />
              <KeyframeMiniEditor
                label="Pan"
                duration={getClipDuration(clip)}
                currentTime={clipLocalTime}
                keyframes={clip.automation?.pan}
                defaultValue={DEFAULT_CLIP_PAN}
                min={MIN_CLIP_PAN}
                max={MAX_CLIP_PAN}
                step={0.01}
                onChange={(track) => {
                  const next: ClipAutomation = { ...(clip.automation ?? {}) };
                  if (track?.length) next.pan = track;
                  else delete next.pan;
                  onAutomationChange(
                    Object.keys(next).length > 0 ? next : undefined,
                  );
                }}
              />
              <KeyframeMiniEditor
                label="Speed (time remap)"
                duration={getClipDuration(clip)}
                currentTime={clipLocalTime}
                keyframes={clip.automation?.playbackRate}
                defaultValue={playbackRateValue}
                min={MIN_CLIP_PLAYBACK_RATE}
                max={MAX_CLIP_PLAYBACK_RATE}
                step={0.01}
                formatValue={(v) => `${v.toFixed(2)}×`}
                valueFieldLabel="rate"
                hitSizePx={32}
                onChange={(track) => {
                  const next: ClipAutomation = { ...(clip.automation ?? {}) };
                  if (track?.length) next.playbackRate = track;
                  else delete next.playbackRate;
                  onAutomationChange(
                    Object.keys(next).length > 0 ? next : undefined,
                  );
                }}
              />
              <p className="inspector-hint">
                Speed keyframe times are output-local clip seconds; source time is the area under
                the rate curve (∫ rate dt). Export / preview share the same OfflineAudioContext
                premix when automation is present.
              </p>
            </div>
          </details>
        )}
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
          <div className="inspector-pip-actions">
            <div className="inspector-pip-header">
              <strong>Picture-in-Picture</strong>
              <span className={isOverlay ? 'inspector-pip-badge is-overlay' : 'inspector-pip-badge'}>
                {isOverlay ? `Overlay • layer ${parseNumber(values.layerIndex, 1)}` : 'Base layer'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => applyPipPreset(pipCorner)}
                title="Composite this clip on top of the base video as a Picture-in-Picture overlay, sized and positioned in the chosen corner."
              >
                🖼 {isOverlay ? 'Reposition overlay' : 'Use as overlay (PiP)'}
              </button>
              <label
                className="inspector-inline-label"
                title="Corner of the canvas the overlay snaps to."
              >
                Corner
                <select
                  value={pipCorner}
                  onChange={(e) => {
                    const corner = e.target.value as PipCorner;
                    setPipCorner(corner);
                    if (isOverlay) applyPipPreset(corner);
                  }}
                >
                  <option value="top-left">Top left</option>
                  <option value="top-right">Top right</option>
                  <option value="bottom-left">Bottom left</option>
                  <option value="bottom-right">Bottom right</option>
                </select>
              </label>
              <button
                type="button"
                className="btn-secondary"
                onClick={useAsBaseLayer}
                disabled={!isOverlay}
                title="Return this clip to the base layer so it plays full-frame in sequence."
              >
                ⤢ Use as base layer
              </button>
            </div>
            <p className="inspector-hint">
              {isOverlay
                ? 'This clip is composited on top of the base video. Fine-tune the size, position and opacity below.'
                : 'Overlay this clip as a small window on top of the base video. You can fine-tune the size, position and opacity afterwards.'}
            </p>
          </div>
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
            <summary>
              Picture-in-Picture layout (advanced){hasAdvancedLayout ? ' • active' : ''}
            </summary>
            <div className="inspector-disclosure-content">
              <label title="0 = base layer (sequential concatenation). 1 or higher = Picture-in-Picture overlay on top of the base video.">
                Layer index (0 = base, 1+ = overlay)
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
              {isOverlay && (
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
        {clip.kind === 'video' && onKeyframesChange && (
          <details
            className="inspector-disclosure"
            open={clip.stillImage || clipHasKeyframes(clip) || parseNumber(values.layerIndex, 0) > 0}
          >
            <summary>
              Keyframe animation
              {clipHasKeyframes(clip) ? ' • active' : ''}
            </summary>
            <div className="inspector-disclosure-content">
              {clip.stillImage && (
                <>
                  <p className="inspector-hint">
                    Still image clip — use Ken Burns for pan/zoom, or animate layout on overlay
                    layers.
                  </p>
                  {onApplyKenBurns && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={onApplyKenBurns}
                    >
                      Apply Ken Burns preset
                    </button>
                  )}
                </>
              )}
              <label className="kf-prop-picker">
                Property
                <select
                  value={activeKeyframeProp}
                  onChange={(e) =>
                    setActiveKeyframeProp(e.target.value as ClipAnimatableProp)
                  }
                >
                  {(clip.stillImage
                    ? [...PIP_KEYFRAME_PROPS, ...KEN_BURNS_PROPS]
                    : PIP_KEYFRAME_PROPS
                  ).map((item) => (
                    <option key={item.prop} value={item.prop}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {(() => {
                const meta =
                  [...PIP_KEYFRAME_PROPS, ...KEN_BURNS_PROPS].find(
                    (item) => item.prop === activeKeyframeProp,
                  ) ?? PIP_KEYFRAME_PROPS[0];
                const isLayoutProp =
                  activeKeyframeProp === 'x' ||
                  activeKeyframeProp === 'y' ||
                  activeKeyframeProp === 'width' ||
                  activeKeyframeProp === 'height';
                const baseDefault =
                  typeof meta.defaultValue === 'function'
                    ? meta.defaultValue(clip)
                    : meta.defaultValue;
                const defaultValue = isLayoutProp
                  ? layoutNormToPixelValue(
                      activeKeyframeProp,
                      baseDefault,
                      layoutCanvas,
                    )
                  : baseDefault;
                const displayKeyframes = isLayoutProp
                  ? clip.keyframes?.[activeKeyframeProp]?.map((key) => ({
                      ...key,
                      value: layoutNormToPixelValue(
                        activeKeyframeProp,
                        key.value,
                        layoutCanvas,
                      ),
                    }))
                  : clip.keyframes?.[activeKeyframeProp];
                return (
                  <KeyframeMiniEditor
                    label={meta.label}
                    duration={getClipDuration(clip)}
                    currentTime={clipLocalTime}
                    keyframes={displayKeyframes}
                    defaultValue={defaultValue}
                    min={meta.min}
                    max={meta.max}
                    step={meta.step}
                    onChange={(track) => {
                      const next: ClipKeyframes = { ...(clip.keyframes ?? {}) };
                      const storedTrack = isLayoutProp
                        ? track?.map((key) => ({
                            ...key,
                            value: layoutPixelToNormValue(
                              activeKeyframeProp,
                              key.value,
                              layoutCanvas,
                            ),
                          }))
                        : track;
                      if (storedTrack?.length) next[activeKeyframeProp] = storedTrack;
                      else delete next[activeKeyframeProp];
                      onKeyframesChange(
                        Object.keys(next).length > 0 ? next : undefined,
                      );
                    }}
                  />
                );
              })()}
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

/**
 * Memoized so unrelated App re-renders (e.g. a timeline reorder) don't
 * re-render the inspector — only its own props (selected clip, settings, …)
 * changing does.
 */
export const Inspector = memo(InspectorImpl);

export type { ClipValues };
