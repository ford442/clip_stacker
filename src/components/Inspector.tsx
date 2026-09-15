import { memo, useEffect, useRef, useState, useMemo } from 'react';
import type { ClipAnimatableProp, ExportSettings } from '../types';
import { RESOLUTION_PRESETS, type ResolutionPreset } from '../types';
import { resolveClipLocalTimeAtGlobal } from '../utils/previewComposition';
import { usePlayheadTime } from '../hooks/usePlayheadTime';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  settingsActions,
  settingsStore,
  useEditorClip,
  useEditorClipGroups,
  useEditorClips,
  useEditorTransitions,
  useSelectedClipId,
} from '../store';
import { extractThumbnails, MIN_CLIP_DURATION } from '../utils/media';
import { isOverlayOffCanvas } from '../utils/project';
import {
  clipLayoutToDisplayPixels,
  layoutPixelToNormValue,
} from '../utils/overlayCoords';
import { extractWaveformPeaks } from '../utils/waveform';
import { clampClipVolume } from '../utils/audioVolume';
import {
  clampClipLoopCount,
  clampClipPlaybackRate,
  DEFAULT_CLIP_PLAYBACK_RATE,
  getTrimmedSourceDuration,
  outputDurationForRate,
} from '../utils/playbackRate';
import {
  buildPipRect,
  buildLogoRect,
  clipAspectRatio,
  nextOverlayLayerIndex,
  parseCanvasSize,
  type PipCorner,
} from '../utils/pipPreset';
import { DEFAULT_CHROMA_KEY } from '../utils/overlayBlend';
import { CaptionsPanel } from './CaptionsPanel';
import { InspectorClipTab } from './inspector/InspectorClipTab';
import { InspectorExportTab } from './inspector/InspectorExportTab';
import {
  clamp,
  findMatchingPreset,
  formatSeconds,
  hasAdvancedLayoutValues,
  INSPECTOR_WAVEFORM_SAMPLES,
  MAX_INSPECTOR_THUMBNAILS,
  MIN_INSPECTOR_THUMBNAILS,
  parseNumber,
  SECONDS_PER_INSPECTOR_THUMBNAIL,
} from './inspector/helpers';
import type { ClipValues, InspectorProps, InspectorTab } from './inspector/types';

function InspectorImpl({
  onChange,
  onKeyframesChange,
  onAutomationChange,
  onApplyKenBurns,
  onExtractAudio,
  onRife,
  onStabilizeChange,
  captions,
}: InspectorProps) {
  const { exportSettings, finishing, rifeProcessing } = useStore(
    settingsStore,
    useShallow((s) => ({
      exportSettings: s.exportSettings,
      finishing: s.finishing,
      rifeProcessing: s.rifeProcessingClipId !== null,
    })),
  );
  const onExportSettingsChange = settingsActions.setExportSettings;
  const onFinishingChange = settingsActions.setFinishing;
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
  const [tab, setTab] = useState<InspectorTab>('clip');
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
    overlayBlend: '',
    chromaColor: DEFAULT_CHROMA_KEY.color,
    chromaSimilarity: String(DEFAULT_CHROMA_KEY.similarity),
    chromaBlend: String(DEFAULT_CHROMA_KEY.blend),
    volume: '1',
    playbackRate: '1',
    loopCount: '1',
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
      overlayBlend: clip.overlayBlend ?? '',
      chromaColor: clip.chromaKey?.color ?? DEFAULT_CHROMA_KEY.color,
      chromaSimilarity: String(clip.chromaKey?.similarity ?? DEFAULT_CHROMA_KEY.similarity),
      chromaBlend: String(clip.chromaKey?.blend ?? DEFAULT_CHROMA_KEY.blend),
      volume: String(clip.volume ?? 1),
      playbackRate: String(clip.playbackRate ?? 1),
      loopCount: String(clip.loopCount ?? 1),
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
  const stabilizeStatus = !clip?.stabilize
    ? null
    : clip.stabilizeError
      ? `Stabilization unavailable — ${clip.stabilizeError}`
      : clip.stabilization
        ? `Steadied: ${(clip.stabilization.maxCorrection * 100).toFixed(1)}% peak shake corrected, ` +
          `${((clip.stabilization.zoom - 1) * 100).toFixed(1)}% crop.`
        : 'Analysing camera motion…';

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

  /**
   * Channel-bug preset: a small corner overlay locked to the source's own
   * aspect ratio, keyed on the source alpha and muted, so a non-square logo
   * composites as a mark rather than a rectangle.
   */
  const applyLogoPreset = (corner: PipCorner) => {
    if (!clip) return;
    const canvas = parseCanvasSize(exportSettings.outputResolution);
    const rect = buildLogoRect(canvas, corner, clipAspectRatio(clip));
    const display = clipLayoutToDisplayPixels(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
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
      overlayBlend: 'source-alpha',
      volume: '0',
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
  const loopCountValue = clampClipLoopCount(parseNumber(values.loopCount, 1));
  /** Total output duration across all loop cycles (one cycle × loopCount). */
  const loopedOutputDuration = outputSpeedDuration * loopCountValue;
  const setPlaybackRate = (rate: number) => {
    update('playbackRate', String(clampClipPlaybackRate(rate)));
  };
  const setLoopCount = (count: number) => {
    update('loopCount', String(clampClipLoopCount(count)));
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
          className={`inspector-tab${tab === 'captions' ? ' active' : ''}`}
          onClick={() => setTab('captions')}
          aria-label="Captions tab"
          aria-selected={tab === 'captions'}
          role="tab"
        >
          Captions
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
        {tab === 'clip' && (
          clip ? (
            <InspectorClipTab
              clip={clip}
              values={values}
              clipLocalTime={clipLocalTime}
              layoutCanvas={layoutCanvas}
              trimStart={trimStart}
              trimEnd={trimEnd}
              trimDuration={trimDuration}
              trimStartPct={trimStartPct}
              trimEndPct={trimEndPct}
              clipPreviewDuration={clipPreviewDuration}
              currentThumbs={currentThumbs}
              currentWave={currentWave}
              volumeValue={volumeValue}
              volumePercent={volumePercent}
              playbackRateValue={playbackRateValue}
              trimmedSourceDuration={trimmedSourceDuration}
              outputSpeedDuration={outputSpeedDuration}
              loopCountValue={loopCountValue}
              loopedOutputDuration={loopedOutputDuration}
              fitBeatCount={fitBeatCount}
              setFitBeatCount={setFitBeatCount}
              isOverlay={isOverlay}
              overlayOffCanvas={overlayOffCanvas}
              hasAdvancedLayout={hasAdvancedLayout}
              advancedOpen={advancedOpen}
              setAdvancedOpen={setAdvancedOpen}
              pipCorner={pipCorner}
              setPipCorner={setPipCorner}
              activeKeyframeProp={activeKeyframeProp}
              setActiveKeyframeProp={setActiveKeyframeProp}
              rifeMultiplier={rifeMultiplier}
              setRifeMultiplier={setRifeMultiplier}
              rifeProcessing={rifeProcessing}
              stabilizeStatus={stabilizeStatus}
              update={update}
              nudge={nudge}
              updateTrimStart={updateTrimStart}
              updateTrimEnd={updateTrimEnd}
              setPlaybackRate={setPlaybackRate}
              setLoopCount={setLoopCount}
              applyPipPreset={applyPipPreset}
              applyLogoPreset={applyLogoPreset}
              useAsBaseLayer={useAsBaseLayer}
              onAutomationChange={onAutomationChange}
              onExtractAudio={onExtractAudio}
              onStabilizeChange={onStabilizeChange}
              onRife={onRife}
              onKeyframesChange={onKeyframesChange}
              onApplyKenBurns={onApplyKenBurns}
            />
          ) : (
            <div className="muted">Select a clip to edit trim and fades.</div>
          )
        )}
        {tab === 'captions' && <CaptionsPanel {...captions} />}
        {tab === 'export' && (
          <InspectorExportTab
            exportSettings={exportSettings}
            finishing={finishing}
            currentPresetName={currentPresetName}
            onExportSettingsChange={onExportSettingsChange}
            onFinishingChange={onFinishingChange}
            updateExport={updateExport}
            updateResolutionPreset={updateResolutionPreset}
          />
        )}
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
