import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  playbackStore,
  setPlayheadTime,
} from "../store/playbackStore";
import { usePlayheadTime } from "../hooks/usePlayheadTime";
import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  Track,
} from "../types";
import type { FinishingSettings } from "../utils/finishing";
import { isFinishingActive } from "../utils/finishing";
import { grainFrameSeedFromTime } from "../utils/grain";
import { sanitizeFilename } from "../utils/filename";
import { computeTotalDuration } from "../utils/transitions";
import { useMediaVolume } from "../hooks/useMediaVolume";
import { useTimelineAudioPlayback } from "../hooks/useTimelineAudioPlayback";
import {
  DEFAULT_PREVIEW_CONSTRAINTS,
  PREVIEW_SIZE_THRESHOLD_PX,
  VIEWPORT_PREVIEW_CONSTRAINTS,
  usePreviewSize,
} from "../hooks/usePreviewSize";
import { PreviewEngine } from "../webgpu/previewEngine";
import { onGpuDeviceLost } from "../webgpu/gpuDevice";
import {
  shouldUseTimelinePreview,
  TimelinePreviewEngine,
} from "../webgpu/timelinePreview";
import { PreviewWorkerAdapter, isCanvasTransferred } from "../webgpu/previewWorkerRuntime";
import {
  renderTextOverlayCanvas,
  renderTextOverlaysAsync,
  TimelineCanvas2DRenderer,
} from "../utils/canvas-renderer";
import type { TimelineCompositor } from "../utils/previewComposition";
import {
  detectCapabilities,
  isCanvas2dAvailable,
  previewBackendLabel,
  selectPreviewBackend,
  type PreviewBackend,
} from "../utils/feature-detector";
import { evaluatePreviewBudget } from "../utils/previewBudget";
import { shouldResetFinishingTemporal } from "../utils/noiseReduction";
import { previewMetrics } from "../utils/previewMetrics";
import { parseOutputResolution } from "../utils/resolution";
import { createRenderScheduler } from "../utils/seekCoalescer";
import { PreviewOverlayManipulator } from "./PreviewOverlayManipulator";

interface Props {
  clip: Clip | null;
  timelineClips?: Clip[];
  tracks?: Track[];
  clipGroups?: ClipGroup[];
  transitions?: ClipTransition[];
  textOverlays?: TextOverlay[];
  exportSettings?: ExportSettings;
  finishing?: FinishingSettings;
  outputUrl: string | null;
  exportFilename?: string;
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

/**
 * WebGPU-accelerated preview. Single-clip mode renders fades live; timeline
 * mode composites multiple layers (hard cuts, dissolves, PiP) from the global
 * playhead position.
 */
function PreviewImpl({
  clip,
  timelineClips = [],
  tracks = [],
  clipGroups = [],
  transitions = [],
  textOverlays = [],
  exportSettings,
  finishing,
  outputUrl,
  exportFilename,
  selectedClipId,
  selectedTextOverlayId,
  onSelectClip,
  onSelectTextOverlay,
  onClipLayoutCommit,
  onTextOverlayLayoutCommit,
  onPreviewDragStart,
}: Props) {
  if (outputUrl) {
    const downloadFilename = exportFilename
      ? sanitizeFilename(exportFilename)
      : "stacked.mp4";
    return (
      <section className="panel">
        <h2>Preview</h2>
        <video
          controls
          src={outputUrl}
          aria-label="Rendered output video preview. Press space to play/pause."
        />
        <a href={outputUrl} download={downloadFilename}>
          Download merged MP4
        </a>
      </section>
    );
  }

  const useTimeline = shouldUseTimelinePreview(
    timelineClips,
    transitions,
    textOverlays,
  );

  if (useTimeline) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <TimelineCompositorPreview
          timelineClips={timelineClips}
          tracks={tracks}
          clipGroups={clipGroups}
          transitions={transitions}
          textOverlays={textOverlays}
          exportSettings={exportSettings}
          finishing={finishing}
          selectedClipId={selectedClipId}
          selectedTextOverlayId={selectedTextOverlayId}
          onSelectClip={onSelectClip}
          onSelectTextOverlay={onSelectTextOverlay}
          onClipLayoutCommit={onClipLayoutCommit}
          onTextOverlayLayoutCommit={onTextOverlayLayoutCommit}
          onPreviewDragStart={onPreviewDragStart}
        />
      </section>
    );
  }

  if (!clip) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <div className="muted">No clip selected.</div>
      </section>
    );
  }

  if (clip.kind === "video") {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <WebGPUVideoPreview
          clip={clip}
          finishing={finishing}
        />
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Preview</h2>
      <AudioClipPreview clip={clip} />
    </section>
  );
}

/** Memoized so unrelated App re-renders (e.g. a text overlay edit) don't re-render the preview. */
export const Preview = memo(PreviewImpl);

// ---------------------------------------------------------------------------
// Timeline WebGPU preview
// ---------------------------------------------------------------------------

interface TimelinePreviewProps {
  timelineClips: Clip[];
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings?: ExportSettings;
  finishing?: FinishingSettings;
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

function TimelineCompositorPreview({
  timelineClips,
  tracks,
  clipGroups,
  transitions,
  textOverlays,
  exportSettings,
  finishing,
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
  const schedulerRef = useRef<ReturnType<typeof createRenderScheduler> | null>(
    null,
  );
  const rafRef = useRef<number>(0);
  const playingRef = useRef(false);
  const globalTimeRef = useRef(playbackStore.getState().playheadTime ?? 0);
  const renderTokenRef = useRef(0);
  const renderFailuresRef = useRef(0);
  const backendRef = useRef<PreviewBackend>("unavailable");
  /** After a post-transfer worker init failure, skip the worker and use main-thread WebGPU. */
  const skipPreviewWorkerRef = useRef(false);
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const [backend, setBackend] = useState<PreviewBackend>("unavailable");
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioClockActive, setAudioClockActive] = useState(false);
  const [degradationMessage, setDegradationMessage] = useState<string | null>(
    null,
  );

  const previewActive = backend !== "unavailable";
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
      if (!engine) return;
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
          },
        );
        if (isCancelled()) return;

        previewMetrics.recordFrame(performance.now() - frameStart);
        previewMetrics.maybeLog();
        renderFailuresRef.current = 0;

        // Final pass: draw text overlays onto the stacked 2D canvas above the
        // video composite (works identically for both backends).
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
          setBackend("unavailable");
          backendRef.current = "unavailable";
        }
      }
    },
    [timelineClips, clipGroups, transitions, textOverlays, exportSettings, finishing],
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
        if (chosen === "webgpu") {
          // Prefer the OffscreenCanvas worker. Probe runs before transfer so a
          // failed probe leaves this canvas usable. A rare post-transfer init
          // failure neuters the element — remount via canvasGeneration and
          // fall back to main-thread WebGPU on the next effect pass.
          if (!skipPreviewWorkerRef.current) {
            engine = await PreviewWorkerAdapter.create(canvas, timelineClips);
          }
          if (!engine) {
            if (isCanvasTransferred(canvas)) {
              skipPreviewWorkerRef.current = true;
              setCanvasGeneration((generation) => generation + 1);
              return;
            }
            engine = await TimelinePreviewEngine.create(canvas, timelineClips);
          }
        } else if (chosen === "canvas2d") {
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
        setBackend("unavailable");
        return;
      }

      engineRef.current = engine;
      backendRef.current = chosen;
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
      backendRef.current = "unavailable";
      setBackend("unavailable");
    };
    // Re-run when canvasGeneration bumps after a neutered-canvas remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasGeneration]);

  // Same reasoning as the single-clip preview: a lost device leaves this
  // engine's draw calls silently no-op-ing rather than throwing, so the
  // existing renderFailuresRef-based fallback may never trip. Drop to
  // "unavailable" immediately so the UI degrades instead of freezing.
  useEffect(() => {
    return onGpuDeviceLost(() => {
      cancelAnimationFrame(rafRef.current);
      schedulerRef.current?.cancel();
      engineRef.current?.destroy();
      engineRef.current = null;
      backendRef.current = "unavailable";
      setBackend("unavailable");
    });
  }, []);

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
  ]);

  useEffect(() => {
    if (!previewSize) return;
    requestRender(playheadTime ?? globalTimeRef.current);
  }, [previewSize, playheadTime, requestRender]);

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

  return (
    <div ref={wrapperRef} className="preview-video-wrapper">
      <div
        className="preview-canvas-stack"
        style={previewActive ? undefined : { display: "none" }}
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
          previewSize && (
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
      </div>
      {!previewActive && (
        <div className="muted" style={{ fontSize: "0.82rem" }}>
          Timeline preview unavailable — this browser supports neither WebGPU nor
          a 2D canvas context.
        </div>
      )}
      {degradationMessage && (
        <p className="preview-degradation-notice" role="status">
          {degradationMessage}
        </p>
      )}
      {previewActive && (
        <div className="preview-gpu-controls">
          <button type="button" onClick={togglePlayback} aria-label="Play/Pause">
            {isPlaying ? "⏸ Pause" : "▶ Play"}
          </button>
          <label className="preview-scrub-label">
            Timeline {displayTime.toFixed(2)}s / {totalDuration.toFixed(2)}s
            <input
              type="range"
              min={0}
              max={Math.max(totalDuration, 0.01)}
              step={0.01}
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
              backend === "webgpu"
                ? "Rendering timeline composition with WebGPU"
                : "Rendering timeline composition with Canvas2D (WebGPU fallback)"
            }
          >
            {previewBackendLabel(backend)}
          </span>
        </div>
      )}
      {typeof displayTime === "number" && (
        <p className="preview-playhead-label">
          Global playhead: {displayTime.toFixed(2)}s
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-clip WebGPU preview
// ---------------------------------------------------------------------------

interface VideoPreviewProps {
  clip: Clip;
  finishing?: FinishingSettings;
}

/** Hidden but still decodable — `display:none` stops frame delivery in Chromium. */
const HIDDEN_VIDEO_STYLE: CSSProperties = {
  position: 'fixed',
  opacity: 0,
  pointerEvents: 'none',
  width: 1,
  height: 1,
};

/** Skip seek when media clock is already within this window of the playhead. */
const SEEK_SYNC_THRESHOLD_SEC = 0.05;

function WebGPUVideoPreview({
  clip,
  finishing,
}: VideoPreviewProps) {
  const playheadTime = usePlayheadTime();
  const viewportRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const rafRef = useRef<number>(0);
  const frameFailuresRef = useRef(0);
  // Keep finishing in a ref so slider edits don't tear down/recreate the GPU engine.
  const finishingRef = useRef(finishing);
  finishingRef.current = finishing;
  // Clip fade/opacity used by the draw loop — updated without remounting the engine.
  const clipDrawRef = useRef(clip);
  clipDrawRef.current = clip;
  // Suppress playhead writes from programmatic seeks (seek effect → seeked → setPlayhead).
  const ignoreSeekReportRef = useRef(false);
  const webGpuAvailable =
    typeof navigator !== "undefined" && "gpu" in navigator;
  const [gpuActive, setGpuActive] = useState(false);
  const [gpuFallback, setGpuFallback] = useState(!webGpuAvailable);
  const [hasFrame, setHasFrame] = useState(false);

  const clipAspectRatio =
    clip.videoWidth && clip.videoHeight && clip.videoHeight > 0
      ? clip.videoWidth / clip.videoHeight
      : 16 / 9;
  const previewSize = usePreviewSize(viewportRef, clipAspectRatio, VIEWPORT_PREVIEW_CONSTRAINTS);
  const previewSizeRef = useRef(previewSize);
  previewSizeRef.current = previewSize;

  useMediaVolume(videoRef, clip.volume, clip.id);

  useEffect(() => {
    setHasFrame(false);
    setGpuActive(false);
    setGpuFallback(!webGpuAvailable);
  }, [clip.id, clip.objectUrl, webGpuAvailable]);

  useEffect(() => {
    let alive = true;
    let engine: PreviewEngine | null = null;
    let rvfcHandle = 0;

    const resizeCanvasIfNeeded = (
      canvas: HTMLCanvasElement,
      eng: PreviewEngine,
    ) => {
      const size = previewSizeRef.current;
      if (!size) return;
      const { canvasWidth: targetWidth, canvasHeight: targetHeight } = size;
      if (
        Math.abs(canvas.width - targetWidth) < PREVIEW_SIZE_THRESHOLD_PX &&
        Math.abs(canvas.height - targetHeight) < PREVIEW_SIZE_THRESHOLD_PX
      ) {
        return;
      }
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      eng.resize();
    };

    const drawOneFrame = () => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!alive || !engine || !canvas || !video) return;

      if (video.readyState < 2) return;

      resizeCanvasIfNeeded(canvas, engine);

      try {
        const frame = new VideoFrame(video);
        frameFailuresRef.current = 0;
        const drawClip = clipDrawRef.current;
        const elapsed = video.currentTime - drawClip.trimStart;
        const duration =
          (Number.isFinite(drawClip.trimEnd) ? drawClip.trimEnd : drawClip.duration) -
          drawClip.trimStart;
        engine.renderFrame(
          frame,
          elapsed,
          duration,
          drawClip.videoFadeIn,
          drawClip.videoFadeOut,
          drawClip.opacity ?? 1,
        );
        const activeFinishing = finishingRef.current;
        if (activeFinishing && isFinishingActive(activeFinishing)) {
          engine.applyFinishing(activeFinishing, {
            frameIndex: grainFrameSeedFromTime(elapsed),
          });
        }
        frame.close();
        setHasFrame(true);
      } catch {
        frameFailuresRef.current += 1;
        if (frameFailuresRef.current >= 30) {
          engine.destroy();
          engineRef.current = null;
          setGpuActive(false);
          setGpuFallback(true);
          setHasFrame(false);
        }
      }
    };

    const scheduleNextFrame = () => {
      if (!alive || !engine) return;
      const video = videoRef.current;
      if (!video) return;

      if (!video.paused && "requestVideoFrameCallback" in video) {
        rvfcHandle = video.requestVideoFrameCallback(() => {
          drawOneFrame();
          scheduleNextFrame();
        });
      } else {
        rafRef.current = requestAnimationFrame(() => {
          drawOneFrame();
          scheduleNextFrame();
        });
      }
    };

    async function init() {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video || !webGpuAvailable) return;

      try {
        engine = await PreviewEngine.create(canvas);
        if (!alive) {
          engine.destroy();
          return;
        }
        engineRef.current = engine;
        setGpuActive(true);
        frameFailuresRef.current = 0;
        scheduleNextFrame();
      } catch {
        engineRef.current = null;
        setGpuFallback(true);
      }
    }

    void init();

    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      const video = videoRef.current;
      if (video && rvfcHandle && "cancelVideoFrameCallback" in video) {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      engine?.destroy();
      engineRef.current = null;
      setGpuActive(false);
    };
  }, [clip.id, clip.objectUrl, webGpuAvailable]);

  // An unexpected device loss (GPU process crash, driver reset) leaves any
  // live `PreviewEngine` holding a dead device — its draw calls silently
  // no-op rather than throwing, so without this the preview would freeze on
  // the last frame with no visible error. Tear it down immediately and fall
  // back to Canvas2D instead of waiting on the existing 30-consecutive-
  // frame-failure detector (which a lost device may never trip). The shared
  // registry recreates a fresh device automatically, so the next preview
  // session (new clip, remount) picks it up transparently.
  useEffect(() => {
    return onGpuDeviceLost(() => {
      engineRef.current?.destroy();
      engineRef.current = null;
      setGpuActive(false);
      setGpuFallback(true);
    });
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || playheadTime == null || !Number.isFinite(playheadTime)) return;
    if (!video.paused) return;

    const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const target = Math.max(clip.trimStart, Math.min(playheadTime, trimEnd));
    if (Math.abs(video.currentTime - target) > SEEK_SYNC_THRESHOLD_SEC) {
      // Suppress seeked/timeupdate → setPlayhead while we drive the media clock.
      // Clear on the next frame so a non-seekable element can't leave the flag stuck
      // (and can't bounce playhead ↔ seek forever when currentTime never lands).
      ignoreSeekReportRef.current = true;
      video.currentTime = target;
      requestAnimationFrame(() => {
        ignoreSeekReportRef.current = false;
      });
    }
  }, [
    clip.id,
    clip.objectUrl,
    clip.trimStart,
    clip.trimEnd,
    clip.duration,
    playheadTime,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const reportTime = () => {
      if (ignoreSeekReportRef.current) return;
      const t = video.currentTime;
      if (!Number.isFinite(t)) return;
      setPlayheadTime(t);
    };
    video.addEventListener("timeupdate", reportTime);
    video.addEventListener("seeked", reportTime);
    return () => {
      video.removeEventListener("timeupdate", reportTime);
      video.removeEventListener("seeked", reportTime);
    };
  }, [clip.id]);

  const viewportStyle = previewSize
    ? { width: previewSize.cssWidth, height: previewSize.cssHeight }
    : undefined;

  return (
    <div className="preview-video-wrapper">
      <div
        ref={viewportRef}
        className="preview-viewport"
        style={viewportStyle}
      >
        <video
          ref={videoRef}
          src={clip.objectUrl}
          controls={gpuFallback}
          style={gpuFallback ? undefined : HIDDEN_VIDEO_STYLE}
          aria-label={`Preview of ${clip.title} video. Press space to play/pause.`}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
        />
        <canvas
          ref={canvasRef}
          className="preview-single-canvas"
          style={{
            display: gpuActive ? "block" : "none",
            visibility: hasFrame ? "visible" : "hidden",
          }}
          aria-label={`WebGPU preview of ${clip.title}`}
          width={1280}
          height={720}
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            v.paused ? v.play() : v.pause();
          }}
        />
      </div>
      {gpuActive && (
        <div className="preview-gpu-controls">
          <button
            type="button"
            onClick={() => {
              videoRef.current?.paused
                ? videoRef.current?.play()
                : videoRef.current?.pause();
            }}
            aria-label="Play/Pause"
          >
            ▶ / ⏸
          </button>
          <span
            className="preview-gpu-badge"
            title="Rendering with WebGPU — fades applied live"
          >
            WebGPU
          </span>
        </div>
      )}
      {typeof playheadTime === "number" && (
        <p className="preview-playhead-label">
          Playhead: {playheadTime.toFixed(2)}s
        </p>
      )}
    </div>
  );
}

function AudioClipPreview({ clip }: { clip: Clip }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useMediaVolume(audioRef, clip.volume, clip.id);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const reportTime = () => {
      const t = audio.currentTime;
      if (!Number.isFinite(t)) return;
      setPlayheadTime(t);
    };
    audio.addEventListener("timeupdate", reportTime);
    audio.addEventListener("seeked", reportTime);
    return () => {
      audio.removeEventListener("timeupdate", reportTime);
      audio.removeEventListener("seeked", reportTime);
    };
  }, [clip.id]);

  return (
    <audio
      ref={audioRef}
      controls
      src={clip.objectUrl}
      aria-label={`Preview of ${clip.title} audio. Press space to play/pause.`}
    />
  );
}
