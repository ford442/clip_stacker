import { useEffect, useRef, useState } from 'react';
import type { Clip } from '../types';
import { sanitizeFilename } from '../utils/filename';
import { PreviewEngine } from '../webgpu/previewEngine';

interface Props {
  clip: Clip | null;
  outputUrl: string | null;
  exportFilename?: string;
}

/**
 * WebGPU-accelerated clip preview. When WebGPU is available and the selected
 * clip is a video, renders frames via a WGSL shader that applies fade-in/out
 * in real time. Falls back to a plain <video> element on unsupported browsers.
 */
export function Preview({ clip, outputUrl, exportFilename }: Props) {
  if (outputUrl) {
    const downloadFilename = exportFilename ? sanitizeFilename(exportFilename) : 'stacked.mp4';
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

  if (!clip) {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <div className="muted">No clip selected.</div>
      </section>
    );
  }

  if (clip.kind === 'video') {
    return (
      <section className="panel">
        <h2>Preview</h2>
        <WebGPUVideoPreview clip={clip} />
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Preview</h2>
      <audio
        controls
        src={clip.objectUrl}
        aria-label={`Preview of ${clip.title} audio. Press space to play/pause.`}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// WebGPU video preview sub-component
// ---------------------------------------------------------------------------

interface VideoPreviewProps {
  clip: Clip;
}

function WebGPUVideoPreview({ clip }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const rafRef = useRef<number>(0);
  const [gpuActive, setGpuActive] = useState(false);

  useEffect(() => {
    let alive = true;
    let engine: PreviewEngine | null = null;

    async function init() {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video || !('gpu' in navigator)) return;

      try {
        engine = await PreviewEngine.create(canvas);
        if (!alive) { engine.destroy(); return; }
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
          // Sync canvas size to video intrinsic size
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth || 1280;
            canvas.height = video.videoHeight || 720;
          }
          try {
            const frame = new VideoFrame(video);
            const elapsed = video.currentTime - clip.trimStart;
            const duration = (Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration) - clip.trimStart;
            engine.renderFrame(frame, elapsed, duration, clip.videoFadeIn, clip.videoFadeOut, clip.opacity ?? 1);
            frame.close();
          } catch {
            // VideoFrame creation can fail on paused / seeking frames — skip
          }
          rafRef.current = requestAnimationFrame(drawLoop);
        };
        rafRef.current = requestAnimationFrame(drawLoop);
      } catch {
        // WebGPU init failed — fall back to plain video (gpuActive stays false)
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
  // Re-init when clip changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

  return (
    <div className="preview-video-wrapper">
      {/* Hidden source video — drives WebGPU frames when GPU is active */}
      <video
        ref={videoRef}
        src={clip.objectUrl}
        controls={!gpuActive}
        style={gpuActive ? { display: 'none' } : undefined}
        aria-label={`Preview of ${clip.title} video. Press space to play/pause.`}
        crossOrigin="anonymous"
      />
      {/* WebGPU canvas — shown only when GPU engine is running */}
      <canvas
        ref={canvasRef}
        style={gpuActive ? undefined : { display: 'none' }}
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
            onClick={() => { videoRef.current?.paused ? videoRef.current?.play() : videoRef.current?.pause(); }}
            aria-label="Play/Pause"
          >
            ▶ / ⏸
          </button>
          <span className="preview-gpu-badge" title="Rendering with WebGPU — fades applied live">
            WebGPU
          </span>
        </div>
      )}
    </div>
  );
}
