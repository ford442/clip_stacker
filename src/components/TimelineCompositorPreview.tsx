import { useCallback, useEffect, useRef, useState } from 'react';
import {
  playbackStore,
  setPlayheadTime,
} from '../store/playbackStore';
import { usePlayheadTime } from '../hooks/usePlayheadTime';
import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  TextOverlayStyle,
  Track,
} from '../types';
import type { FinishingSettings } from '../utils/finishing';
import type { ColorManagementSettings } from '../utils/colorManagement';
import { computeTotalDuration } from '../utils/transitions';
import { useTimelineAudioPlayback } from '../hooks/useTimelineAudioPlayback';
import { usePlaybackAnalyserLevels } from '../hooks/usePlaybackAnalyserLevels';
import {
  DEFAULT_PREVIEW_CONSTRAINTS,
  usePreviewSize,
} from '../hooks/usePreviewSize';
import {
  getPublishedWebGpuProbe,
  type WebGpuProbeResult,
} from '../webgpu/webgpuProbe';
import { PreviewWorkerAdapter } from '../webgpu/previewWorkerAdapter';
import { isCanvasTransferred } from '../webgpu/previewWorkerRuntime';
import type { ScopeData } from '../webgpu/previewWorkerProtocol';
import { PreviewScopes } from './PreviewScopes';
import {
  renderTextOverlayCanvas,
  renderTextOverlaysAsync,
} from '../utils/canvas-renderer-compositor';
import type { TimelineCompositor } from '../utils/previewComposition';
import {
  detectCapabilities,
  isCanvas2dAvailable,
  previewBackendLabel,
  selectPreviewBackend,
  type PreviewBackend,
} from '../utils/feature-detector';
import { evaluatePreviewBudget } from '../utils/previewBudget';
import { shouldResetFinishingTemporal } from '../utils/noiseReduction';
import { previewMetrics } from '../utils/previewMetrics';
import { useProxyState } from '../store/proxyStore';
import { parseOutputResolution } from '../utils/resolution';
import { createRenderScheduler } from '../utils/seekCoalescer';
import { PreviewOverlayManipulator } from './PreviewOverlayManipulator';
import { displayedWebGpuProbe, WebGpuHardFailBanner } from './previewWebGpuFail';

export interface TimelinePreviewProps {
  timelineClips: Clip[];
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  /** Caption cues to draw over the composite (empty when the toggle is off). */
  captions?: CaptionEntry[];
  captionStyle?: Partial<TextOverlayStyle>;
  exportSettings?: ExportSettings;
  finishing?: FinishingSettings;
  colorManagement?: ColorManagementSettings;
  selectedClipId?: string | null;
  selectedTextOverlayId?: string | null;
  onSelectClip?: (clipId: string | null) => void;
  onSelectTextOverlay?: (overlayId: string | null) => void;
  onClipLayoutCommit?: (clipId: string, clip: Clip, editedKeyframe: boolean) => void;
  onTextOverlayLayoutCommit?: (
    overlayId: string,
    overlay: TextOverlay,
    editedKeyframe: boolean,
  ) => void;
  onPreviewDragStart?: () => void;
}

export function TimelineCompositorPreview({
  timelineClips,
  tracks,
  clipGroups,
  transitions,
  textOverlays,
  captions,
  captionStyle,
  exportSettings,
  finishing,
  colorManagement,
  selectedClipId = null,
  selectedTextOverlayId = null,
  onSelectClip,
  onSelectTextOverlay,
  onClipLayoutCommit,
  onTextOverlayLayoutCommit,
  onPreviewDragStart,
}: TimelinePreviewProps) {
  const playheadTime = usePlayheadTime();
  const audioPlayback = useTimelineAudioPlayback(
    timelineClips,
    clipGroups,
    transitions,
    tracks,
  );
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<TimelineCompositor | null>(null);
  // Scopes are off by default — each enabled scope costs a compute dispatch and
  // a readback per composed frame.
  const [showWaveform, setShowWaveform] = useState(false);
  const [showVectorscope, setShowVectorscope] = useState(false);
  const [scopeData, setScopeData] = useState<ScopeData | null>(null);
  const schedulerRef = useRef<ReturnType<typeof createRenderScheduler> | null>(
    null,
  );
  const rafRef = useRef<number>(0);
  const playingRef = useRef(false);
  const globalTimeRef = useRef(playbackStore.getState().playheadTime ?? 0);
  const renderTokenRef = useRef(0);
  const renderFailuresRef = useRef(0);
  const backendRef = useRef<PreviewBackend>('unavailable');
  /** The backend `init` picked — restored when a lost device comes back. */
  const engineBackendRef = useRef<PreviewBackend>('unavailable');
  /** True between the compositor's device loss and its recovery: renders would no-op. */
  const deviceLostRef = useRef(false);
  /** After a post-transfer worker init failure, skip the worker and use main-thread WebGPU. */
  const skipPreviewWorkerRef = useRef(false);
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const [backend, setBackend] = useState<PreviewBackend>('unavailable');
  const [gpuProbe, setGpuProbe] = useState<WebGpuProbeResult | undefined>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioClockActive, setAudioClockActive] = useState(false);
  const [degradationMessage, setDegradationMessage] = useState<string | null>(
    null,
  );

  const previewActive = backend !== 'unavailable';
  const totalDuration = computeTotalDuration(timelineClips, transitions);

  const { width: outputWidth, height: outputHeight } = parseOutputResolution(
    exportSettings?.outputResolution,
  );
  const timelineAspectRatio =
    outputWidth > 0 && outputHeight > 0 ? outputWidth / outputHeight : 16 / 9;
  const previewSize = usePreviewSize(wrapperRef, timelineAspectRatio, DEFAULT_PREVIEW_CONSTRAINTS);
  const previewSizeRef = useRef(previewSize);
  previewSizeRef.current = previewSize;
  const lastRenderedTimeRef = useRef<number | null>(null);

  const renderAt = useCallback(
    async (globalTime: number) => {
      const engine = engineRef.current;
      if (!engine || deviceLostRef.current) return;
      const lastTime = lastRenderedTimeRef.current;
      // Clear temporal NR on any backward scrub or large discontinuous seek.
      if (shouldResetFinishingTemporal(lastTime, globalTime, !!playingRef.current)) {
        engine.resetFinishingTemporal?.();
      }
      lastRenderedTimeRef.current = globalTime;
      const token = ++renderTokenRef.current;
      const isCancelled = () => token !== renderTokenRef.current;
      const frameStart = performance.now();
      const size = previewSizeRef.current;
      try {
        const plan = await engine.renderTimelineFrame(
          timelineClips,
          clipGroups,
          transitions,
          textOverlays,
          exportSettings,
          globalTime,
          {
            isCancelled,
            maxHeight: size?.canvasHeight,
            maxWidth: size?.canvasWidth,
            finishing,
            colorManagement,
            captions,
            captionStyle,
          },
        );
        if (isCancelled()) return;

        previewMetrics.recordFrame(performance.now() - frameStart);
        previewMetrics.maybeLog();
        renderFailuresRef.current = 0;

        // Final pass: draw text overlays onto the stacked 2D canvas above the
        // video composite (works identically for both backends).
        // Captions ride the same overlay canvas as text overlays, so they are
        // drawn whenever the plan carries a caption layer.
        if (textCanvasRef.current && !isCancelled()) {
          if (textOverlays.some((o) => o.fill === 'shader')) {
            await renderTextOverlaysAsync(textCanvasRef.current, plan);
          } else {
            renderTextOverlayCanvas(textCanvasRef.current, plan);
          }
        }

        const { height: outputHeight } = parseOutputResolution(
          exportSettings?.outputResolution,
        );
        const budget = evaluatePreviewBudget({
          backend: backendRef.current,
          capped: plan.capped,
          outputHeight,
          cappedHeight: plan.canvasHeight,
          layerCount: plan.layers.length,
        });
        setDegradationMessage(budget.message);
      } catch {
        if (isCancelled()) return;
        renderFailuresRef.current += 1;
        if (renderFailuresRef.current >= 5) {
          setBackend('unavailable');
          backendRef.current = 'unavailable';
        }
      }
    },
    [
      timelineClips,
      clipGroups,
      transitions,
      textOverlays,
      captions,
      captionStyle,
      exportSettings,
      finishing,
      colorManagement,
    ],
  );

  const requestRender = useCallback((globalTime: number) => {
    schedulerRef.current?.request(globalTime);
  }, []);

  useEffect(() => {
    schedulerRef.current = createRenderScheduler(renderAt, () => {
      // Cancelling an in-flight composite during playback leaves a blank canvas.
      if (!playingRef.current) {
        renderTokenRef.current += 1;
      }
    });
    return () => {
      schedulerRef.current?.cancel();
      schedulerRef.current = null;
    };
  }, [renderAt]);

  useEffect(() => {
    let alive = true;
    let engine: TimelineCompositor | null = null;

    async function init() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Feature-detect and pick the backend before touching the canvas (a
      // canvas can only host one context type, so we must not attempt WebGPU
      // unless detection says it will work).
      const caps = await detectCapabilities();
      if (!alive) return;
      const estimatedLayers = timelineClips.length + textOverlays.length;
      const chosen = selectPreviewBackend(
        caps,
        estimatedLayers,
        isCanvas2dAvailable(),
      );

      try {
        if (chosen === 'webgpu') {
          // Prefer the OffscreenCanvas worker. Probe runs before transfer so a
          // failed probe never neuters this canvas. Post-transfer init failure
          // remounts via canvasGeneration and uses main-thread WebGPU only when
          // the worker probe already succeeded.
          if (!skipPreviewWorkerRef.current && caps.offscreenCanvas) {
            engine = await PreviewWorkerAdapter.create(canvas, timelineClips);
          }
          if (!engine) {
            if (isCanvasTransferred(canvas)) {
              skipPreviewWorkerRef.current = true;
              setCanvasGeneration((generation) => generation + 1);
              return;
            }
            const workerProbe = getPublishedWebGpuProbe().worker;
            const workerFailed = workerProbe ? !workerProbe.ok : false;
            const allowMainGpu =
              caps.webgpu &&
              !workerFailed &&
              (skipPreviewWorkerRef.current || !caps.offscreenCanvas);
            if (allowMainGpu) {
              // The main-thread compositor (preview engine + finishing pass
              // chain) is the fallback for browsers without OffscreenCanvas
              // workers; the worker bundles its own copy, so main only loads
              // it here. A failed load lands in the catch below like a failed
              // create().
              const { TimelinePreviewEngine } = await import('../webgpu/timelinePreview');
              if (!alive) return;
              engine = await TimelinePreviewEngine.create(canvas, timelineClips);
            }
          }
        } else if (chosen === 'canvas2d') {
          const { TimelineCanvas2DRenderer } = await import('../utils/canvas-renderer-timeline');
          if (!alive) return;
          engine = TimelineCanvas2DRenderer.create(canvas, timelineClips);
        }
      } catch {
        engine = null;
      }

      if (!alive) {
        engine?.destroy();
        return;
      }
      if (!engine) {
        engineRef.current = null;
        setGpuProbe(displayedWebGpuProbe());
        setBackend('unavailable');
        return;
      }

      engineRef.current = engine;
      backendRef.current = chosen;
      engineBackendRef.current = chosen;
      deviceLostRef.current = false;
      setBackend(chosen);
      if (textOverlays.some((o) => o.fill === 'shader') && chosen !== 'webgpu') {
        setDegradationMessage(
          'Shader text requires WebGPU, which isn’t available here — showing a solid-color fallback. ' +
            'Switch Fill to Solid on the overlay to match what FFmpeg export will produce, or preview on a WebGPU-capable browser/device to see the shader.',
        );
      }
      renderFailuresRef.current = 0;
      const time = playbackStore.getState().playheadTime ?? globalTimeRef.current;
      globalTimeRef.current = time;
      await renderAt(time);
    }

    void init();

    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      schedulerRef.current?.cancel();
      engine?.pauseDecoders();
      engine?.destroy();
      engineRef.current = null;
      backendRef.current = 'unavailable';
      setBackend('unavailable');
    };
    // Re-run when canvasGeneration bumps after a neutered-canvas remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasGeneration]);

  // Watch the device *this* compositor draws with — the worker's own device
  // on the worker backend, never main's (losing the export device must not
  // tear down a healthy preview). A lost device makes draws no-op silently,
  // so the render-failure counter may never trip: pause rendering until the
  // engine has rebuilt on the recreated device, and give up only if the
  // recreate fails.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine?.onDeviceState) return;
    return engine.onDeviceState((state, message) => {
      if (engineRef.current !== engine) return;
      if (state === 'lost') {
        deviceLostRef.current = true;
        schedulerRef.current?.cancel();
        renderTokenRef.current += 1;
        setDegradationMessage(
          `GPU device lost${message ? ` (${message})` : ''} — recovering the preview…`,
        );
        return;
      }
      if (state === 'recovered') {
        deviceLostRef.current = false;
        renderFailuresRef.current = 0;
        lastRenderedTimeRef.current = null;
        backendRef.current = engineBackendRef.current;
        setBackend(engineBackendRef.current);
        setDegradationMessage(null);
        requestRender(globalTimeRef.current);
        return;
      }
      cancelAnimationFrame(rafRef.current);
      schedulerRef.current?.cancel();
      engine.destroy();
      engineRef.current = null;
      backendRef.current = 'unavailable';
      setBackend('unavailable');
      setGpuProbe(displayedWebGpuProbe());
      setDegradationMessage(
        `GPU device lost and could not be recreated${message ? ` (${message})` : ''}. Reload the page to restore the preview.`,
      );
    });
  }, [backend, canvasGeneration, requestRender]);

  // Only the worker-backed WebGPU compositor can produce scopes: they are read
  // from the composed GPU texture, which the Canvas2D path does not have.
  useEffect(() => {
    const engine = engineRef.current;
    if (!(engine instanceof PreviewWorkerAdapter)) {
      setScopeData(null);
      return;
    }
    engine.setScopes({ waveform: showWaveform, vectorscope: showVectorscope }, (data) =>
      setScopeData(data),
    );
    if (!showWaveform && !showVectorscope) setScopeData(null);
  }, [showWaveform, showVectorscope, backend, canvasGeneration]);

  // A proxy becoming ready (or the proxy toggle flipping) changes which bytes
  // a layer decodes, so it re-syncs clip media like a clip edit does.
  const proxiesEnabled = useProxyState((s) => s.enabled);
  const readyProxies = useProxyState((s) => s.ready);

  useEffect(() => {
    engineRef.current?.syncClips(timelineClips);
    const time = playheadTime ?? globalTimeRef.current;
    globalTimeRef.current = time;
    // Playback tick drives renders; playhead updates here would double-fire and,
    // while paused scrubbing, this is the sole render trigger.
    if (!playingRef.current) {
      requestRender(time);
    }
  }, [
    timelineClips,
    clipGroups,
    transitions,
    textOverlays,
    exportSettings,
    playheadTime,
    requestRender,
    proxiesEnabled,
    readyProxies,
  ]);

  useEffect(() => {
    if (!previewSize) return;
    requestRender(playheadTime ?? globalTimeRef.current);
  }, [previewSize, playheadTime, requestRender]);

  // Dragging the timeline ruler takes the playhead: playback pauses (in place,
  // without writing the old time back over the scrub position) and the paused
  // render path follows the playhead from here.
  useEffect(
    () =>
      playbackStore.subscribe((state, prev) => {
        if (!state.scrubbing || prev.scrubbing || !playingRef.current) return;
        playingRef.current = false;
        audioPlayback.pause();
        setAudioClockActive(false);
        setIsPlaying(false);
      }),
    [audioPlayback],
  );

  useEffect(() => {
    playingRef.current = isPlaying;
    if (isPlaying || !previewActive) return;
    cancelAnimationFrame(rafRef.current);
    engineRef.current?.pauseDecoders();
  }, [isPlaying, previewActive]);

  useEffect(() => {
    playingRef.current = isPlaying;
    if (!isPlaying || !previewActive) return;

    let lastWall = performance.now();

    const tick = (now: number) => {
      if (!playingRef.current) return;

      let next: number;
      if (audioClockActive) {
        next = Math.min(totalDuration, audioPlayback.getCurrentTime());
      } else {
        const dt = (now - lastWall) / 1000;
        lastWall = now;
        next = Math.min(totalDuration, globalTimeRef.current + dt);
      }

      globalTimeRef.current = next;
      setPlayheadTime(next);
      requestRender(next);
      if (next >= totalDuration - 1e-3) {
        audioPlayback.pause();
        setAudioClockActive(false);
        setIsPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [
    isPlaying,
    previewActive,
    totalDuration,
    requestRender,
    audioPlayback,
    audioClockActive,
  ]);

  const togglePlayback = async () => {
    if (isPlaying) {
      const pausedAt = audioPlayback.pause();
      globalTimeRef.current = pausedAt;
      setPlayheadTime(pausedAt);
      setAudioClockActive(false);
      setIsPlaying(false);
      return;
    }
    let startAt = globalTimeRef.current;
    if (startAt >= totalDuration - 1e-3) {
      startAt = 0;
      globalTimeRef.current = 0;
      setPlayheadTime(0);
    }
    // Resume AudioContext from this user gesture; fall back to wall-clock
    // visual playback (muted) when Web Audio is unavailable.
    const started = await audioPlayback.play(startAt);
    setAudioClockActive(started);
    setIsPlaying(true);
  };

  const displayTime = playheadTime ?? globalTimeRef.current;
  const meter = usePlaybackAnalyserLevels(audioPlayback, isPlaying && audioClockActive);

  return (
    <div ref={wrapperRef} className="preview-video-wrapper">
      <div
        className="preview-canvas-stack"
        style={{ '--preview-aspect': timelineAspectRatio } as React.CSSProperties}
      >
        <canvas
          key={canvasGeneration}
          ref={canvasRef}
          className="preview-timeline-canvas"
          aria-label="Timeline composition preview"
          width={1280}
          height={720}
          onClick={togglePlayback}
        />
        <canvas
          ref={textCanvasRef}
          className="preview-text-overlay-canvas"
          aria-hidden="true"
          width={1280}
          height={720}
        />
        {onClipLayoutCommit &&
          onTextOverlayLayoutCommit &&
          onPreviewDragStart &&
          onSelectClip &&
          onSelectTextOverlay &&
          previewSize &&
          previewActive && (
            <PreviewOverlayManipulator
              timelineClips={timelineClips}
              clipGroups={clipGroups}
              transitions={transitions}
              textOverlays={textOverlays}
              exportSettings={exportSettings}
              playheadTime={displayTime}
              selectedClipId={selectedClipId ?? null}
              selectedTextOverlayId={selectedTextOverlayId ?? null}
              canvasWidth={previewSize.canvasWidth}
              canvasHeight={previewSize.canvasHeight}
              onSelectClip={onSelectClip}
              onSelectTextOverlay={onSelectTextOverlay}
              onClipLayoutCommit={onClipLayoutCommit}
              onTextOverlayCommit={onTextOverlayLayoutCommit}
              onDragStart={onPreviewDragStart}
            />
          )}
        {!previewActive && <WebGpuHardFailBanner probe={gpuProbe} />}
      </div>
      {degradationMessage && (
        <p className="preview-degradation-notice" role="status">
          {degradationMessage}
        </p>
      )}
      {previewActive && (
        <div className="preview-gpu-controls">
          <button type="button" onClick={togglePlayback} aria-label="Play/Pause">
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <span
            className="preview-audio-meter"
            title={
              audioClockActive
                ? 'Web Audio playback meter (AnalyserNode)'
                : 'Web Audio unavailable — muted wall-clock preview'
            }
            aria-hidden="true"
          >
            <span
              className="preview-audio-meter-fill"
              style={{
                transform: `scaleX(${Math.min(1, meter.rms * 3).toFixed(3)})`,
              }}
            />
          </span>
          <label className="preview-scrub-label">
            Timeline {displayTime.toFixed(2)}s / {totalDuration.toFixed(2)}s
            <input
              type="range"
              min={0}
              max={Math.max(totalDuration, 0.01)}
              step={1 / 30}
              value={Math.min(displayTime, totalDuration)}
              onChange={(e) => {
                const next = Number(e.target.value);
                globalTimeRef.current = next;
                setPlayheadTime(next);
                requestRender(next);
                void audioPlayback.seek(next);
              }}
            />
          </label>
          <span
            className="preview-gpu-badge"
            title={
              backend === 'webgpu'
                ? 'Rendering timeline composition with WebGPU'
                : 'Canvas2D compositor because the timeline exceeds the WebGPU layer budget (not a GPU fallback)'
            }
          >
            {previewBackendLabel(backend)}
          </span>
          <label className="preview-scope-toggle">
            <input
              type="checkbox"
              checked={showWaveform}
              onChange={(e) => setShowWaveform(e.target.checked)}
            />
            Waveform
          </label>
          <label className="preview-scope-toggle">
            <input
              type="checkbox"
              checked={showVectorscope}
              onChange={(e) => setShowVectorscope(e.target.checked)}
            />
            Vectorscope
          </label>
        </div>
      )}
      {previewActive && (
        <PreviewScopes
          data={scopeData}
          showWaveform={showWaveform}
          showVectorscope={showVectorscope}
        />
      )}
      {typeof displayTime === 'number' && (
        <p className="preview-playhead-label">
          Global playhead: {displayTime.toFixed(2)}s
        </p>
      )}
    </div>
  );
}
