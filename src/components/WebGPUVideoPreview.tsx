import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { setPlayheadTime } from '../store/playbackStore';
import { usePlayheadTime } from '../hooks/usePlayheadTime';
import type { Clip } from '../types';
import type { FinishingSettings } from '../utils/finishing';
import { isFinishingActive } from '../utils/finishing';
import { grainFrameSeedFromTime } from '../utils/grain';
import { useMediaVolume } from '../hooks/useMediaVolume';
import {
  PREVIEW_SIZE_THRESHOLD_PX,
  VIEWPORT_PREVIEW_CONSTRAINTS,
  usePreviewSize,
} from '../hooks/usePreviewSize';
import { PreviewEngine } from '../webgpu/previewEngine';
import { onGpuDeviceLost } from '../webgpu/gpuDevice';
import { probeWebGpu, publishWebGpuProbe } from '../webgpu/webgpuProbe';
import { displayedWebGpuProbe, WebGpuHardFailBanner } from './previewWebGpuFail';

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

export function WebGPUVideoPreview({
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
    typeof navigator !== 'undefined' && 'gpu' in navigator;
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

      if (!video.paused && 'requestVideoFrameCallback' in video) {
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
      if (!canvas || !video) return;

      const probe = await probeWebGpu();
      publishWebGpuProbe('main', probe);
      if (!alive) return;
      if (!probe.ok) {
        setGpuFallback(true);
        return;
      }

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
      if (video && rvfcHandle && 'cancelVideoFrameCallback' in video) {
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
  // the last frame with no visible error. Tear it down immediately and hard-fail
  // GPU preview instead of waiting on the 30-consecutive-frame-failure
  // detector (which a lost device may never trip). Do not switch to Canvas2D.
  // The shared registry may recreate a device; a later remount can pick it up.
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
    video.addEventListener('timeupdate', reportTime);
    video.addEventListener('seeked', reportTime);
    return () => {
      video.removeEventListener('timeupdate', reportTime);
      video.removeEventListener('seeked', reportTime);
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
          controls={false}
          style={HIDDEN_VIDEO_STYLE}
          aria-label={`Preview of ${clip.title} video. Press space to play/pause.`}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
        />
        <canvas
          ref={canvasRef}
          className="preview-single-canvas"
          style={{
            display: gpuActive ? 'block' : 'none',
            visibility: hasFrame ? 'visible' : 'hidden',
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
        {gpuFallback && <WebGpuHardFailBanner probe={displayedWebGpuProbe()} />}
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
      {typeof playheadTime === 'number' && (
        <p className="preview-playhead-label">
          Playhead: {playheadTime.toFixed(2)}s
        </p>
      )}
    </div>
  );
}
