import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
} from "../types";
import { sanitizeFilename } from "../utils/filename";
import { computeTotalDuration } from "../utils/transitions";
import { useMediaVolume } from "../hooks/useMediaVolume";
import { PreviewEngine } from "../webgpu/previewEngine";
import {
  shouldUseTimelinePreview,
  TimelinePreviewEngine,
} from "../webgpu/timelinePreview";
import {
  renderTextOverlayCanvas,
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
import { previewMetrics } from "../utils/previewMetrics";
import { parseOutputResolution } from "../utils/resolution";
import { createRenderScheduler } from "../utils/seekCoalescer";

interface Props {
  clip: Clip | null;
  timelineClips?: Clip[];
  clipGroups?: ClipGroup[];
  transitions?: ClipTransition[];
  textOverlays?: TextOverlay[];
  exportSettings?: ExportSettings;
  outputUrl: string | null;
  exportFilename?: string;
  playheadTime?: number | null;
  onPlayheadChange?: (time: number) => void;
}

/**
 * WebGPU-accelerated preview. Single-clip mode renders fades live; timeline
 * mode composites multiple layers (hard cuts, dissolves, PiP) from the global
 * playhead position.
 */
export function Preview({
  clip,
  timelineClips = [],
  clipGroups = [],
  transitions = [],
  textOverlays = [],
  exportSettings,
  outputUrl,
  exportFilename,
  playheadTime,
  onPlayheadChange,
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

  const useTimeline = shouldUseTimelinePreview(timelineClips);

  if (useTimeline) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <TimelineCompositorPreview
          timelineClips={timelineClips}
          clipGroups={clipGroups}
          transitions={transitions}
          textOverlays={textOverlays}
          exportSettings={exportSettings}
          playheadTime={playheadTime}
          onPlayheadChange={onPlayheadChange}
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
          playheadTime={playheadTime}
          onPlayheadChange={onPlayheadChange}
        />
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Preview</h2>
      <AudioClipPreview clip={clip} onPlayheadChange={onPlayheadChange} />
      {typeof playheadTime === "number" && (
        <p className="preview-playhead-label">
          Playhead: {playheadTime.toFixed(2)}s
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Timeline WebGPU preview
// ---------------------------------------------------------------------------

interface TimelinePreviewProps {
  timelineClips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings?: ExportSettings;
  playheadTime?: number | null;
  onPlayheadChange?: (time: number) => void;
}

function TimelineCompositorPreview({
  timelineClips,
  clipGroups,
  transitions,
  textOverlays,
  exportSettings,
  playheadTime,
  onPlayheadChange,
}: TimelinePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TimelineCompositor | null>(null);
  const schedulerRef = useRef<ReturnType<typeof createRenderScheduler> | null>(
    null,
  );
  const rafRef = useRef<number>(0);
  const playingRef = useRef(false);
  const globalTimeRef = useRef(playheadTime ?? 0);
  const renderTokenRef = useRef(0);
  const backendRef = useRef<PreviewBackend>("unavailable");
  const [backend, setBackend] = useState<PreviewBackend>("unavailable");
  const [isPlaying, setIsPlaying] = useState(false);
  const [degradationMessage, setDegradationMessage] = useState<string | null>(
    null,
  );

  const previewActive = backend !== "unavailable";
  const totalDuration = computeTotalDuration(timelineClips, transitions);

  const renderAt = useCallback(
    async (globalTime: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      const token = ++renderTokenRef.current;
      const frameStart = performance.now();
      try {
        const plan = await engine.renderTimelineFrame(
          timelineClips,
          clipGroups,
          transitions,
          textOverlays,
          exportSettings,
          globalTime,
        );
        previewMetrics.recordFrame(performance.now() - frameStart);
        previewMetrics.maybeLog();

        // Final pass: draw text overlays onto the stacked 2D canvas above the
        // video composite (works identically for both backends).
        if (token === renderTokenRef.current && textCanvasRef.current) {
          renderTextOverlayCanvas(textCanvasRef.current, plan);
        }

        if (token === renderTokenRef.current) {
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
        }
      } catch {
        if (token === renderTokenRef.current) {
          setBackend("unavailable");
          backendRef.current = "unavailable";
        }
      }
    },
    [timelineClips, clipGroups, transitions, textOverlays, exportSettings],
  );

  const requestRender = useCallback((globalTime: number) => {
    schedulerRef.current?.request(globalTime);
  }, []);

  useEffect(() => {
    schedulerRef.current = createRenderScheduler(renderAt);
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
          engine = await TimelinePreviewEngine.create(canvas, timelineClips);
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
      const time = playheadTime ?? globalTimeRef.current;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.syncClips(timelineClips);
    const time = playheadTime ?? globalTimeRef.current;
    globalTimeRef.current = time;
    requestRender(time);
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
    playingRef.current = isPlaying;
    if (isPlaying || !previewActive) return;
    cancelAnimationFrame(rafRef.current);
    engineRef.current?.pauseDecoders();
  }, [isPlaying, previewActive]);

  useEffect(() => {
    playingRef.current = isPlaying;
    if (!isPlaying || !previewActive) return;

    let last = performance.now();
    const tick = (now: number) => {
      if (!playingRef.current) return;
      const dt = (now - last) / 1000;
      last = now;
      const next = Math.min(totalDuration, globalTimeRef.current + dt);
      globalTimeRef.current = next;
      onPlayheadChange?.(next);
      requestRender(next);
      if (next >= totalDuration - 1e-3) {
        setIsPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, previewActive, totalDuration, onPlayheadChange, requestRender]);

  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (globalTimeRef.current >= totalDuration - 1e-3) {
      globalTimeRef.current = 0;
      onPlayheadChange?.(0);
    }
    setIsPlaying(true);
  };

  const displayTime = playheadTime ?? globalTimeRef.current;

  return (
    <div className="preview-video-wrapper">
      <div
        className="preview-canvas-stack"
        style={previewActive ? undefined : { display: "none" }}
      >
        <canvas
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
                onPlayheadChange?.(next);
                requestRender(next);
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
  playheadTime?: number | null;
  onPlayheadChange?: (time: number) => void;
}

function WebGPUVideoPreview({ clip, playheadTime, onPlayheadChange }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const rafRef = useRef<number>(0);
  const [gpuActive, setGpuActive] = useState(false);

  useMediaVolume(videoRef, clip.volume, clip.id);

  useEffect(() => {
    let alive = true;
    let engine: PreviewEngine | null = null;

    async function init() {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video || !("gpu" in navigator)) return;

      try {
        engine = await PreviewEngine.create(canvas);
        if (!alive) {
          engine.destroy();
          return;
        }
        engineRef.current = engine;
        setGpuActive(true);

        const drawLoop = () => {
          if (!alive || !engine || video.paused || video.ended) {
            rafRef.current = requestAnimationFrame(drawLoop);
            return;
          }
          if (video.readyState < 2) {
            rafRef.current = requestAnimationFrame(drawLoop);
            return;
          }
          if (
            canvas.width !== video.videoWidth ||
            canvas.height !== video.videoHeight
          ) {
            canvas.width = video.videoWidth || 1280;
            canvas.height = video.videoHeight || 720;
          }
          try {
            const frame = new VideoFrame(video);
            const elapsed = video.currentTime - clip.trimStart;
            const duration =
              (Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration) -
              clip.trimStart;
            engine.renderFrame(
              frame,
              elapsed,
              duration,
              clip.videoFadeIn,
              clip.videoFadeOut,
              clip.opacity ?? 1,
            );
            frame.close();
          } catch {
            // VideoFrame creation can fail on paused / seeking frames — skip
          }
          rafRef.current = requestAnimationFrame(drawLoop);
        };
        rafRef.current = requestAnimationFrame(drawLoop);
      } catch {
        engineRef.current = null;
      }
    }

    init();

    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      engine?.destroy();
      engineRef.current = null;
      setGpuActive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onPlayheadChange) return;

    const reportTime = () => onPlayheadChange(video.currentTime);
    video.addEventListener("timeupdate", reportTime);
    video.addEventListener("seeked", reportTime);
    return () => {
      video.removeEventListener("timeupdate", reportTime);
      video.removeEventListener("seeked", reportTime);
    };
  }, [clip.id, onPlayheadChange]);

  return (
    <div className="preview-video-wrapper">
      <video
        ref={videoRef}
        src={clip.objectUrl}
        controls={!gpuActive}
        style={gpuActive ? { display: "none" } : undefined}
        aria-label={`Preview of ${clip.title} video. Press space to play/pause.`}
        crossOrigin="anonymous"
      />
      <canvas
        ref={canvasRef}
        style={gpuActive ? undefined : { display: "none" }}
        aria-label={`WebGPU preview of ${clip.title}`}
        width={1280}
        height={720}
        onClick={() => {
          const v = videoRef.current;
          if (!v) return;
          v.paused ? v.play() : v.pause();
        }}
      />
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

function AudioClipPreview({
  clip,
  onPlayheadChange,
}: {
  clip: Clip;
  onPlayheadChange?: (time: number) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useMediaVolume(audioRef, clip.volume, clip.id);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !onPlayheadChange) return;

    const reportTime = () => onPlayheadChange(audio.currentTime);
    audio.addEventListener("timeupdate", reportTime);
    audio.addEventListener("seeked", reportTime);
    return () => {
      audio.removeEventListener("timeupdate", reportTime);
      audio.removeEventListener("seeked", reportTime);
    };
  }, [clip.id, onPlayheadChange]);

  return (
    <audio
      ref={audioRef}
      controls
      src={clip.objectUrl}
      aria-label={`Preview of ${clip.title} audio. Press space to play/pause.`}
    />
  );
}
