import { useEffect, useMemo, useRef } from 'react';
import {
  computeFadePreviewAlpha,
  getFadePreviewTiming,
  type FadeDirection,
} from '../utils/fadePreview';

const PREVIEW_WIDTH = 88;
const PREVIEW_HEIGHT = 72;

interface Props {
  objectUrl?: string;
  peaks?: Float32Array;
  trimStart: number;
  trimEnd: number;
  clipDuration: number;
  fadeDuration: number;
  direction: FadeDirection;
  tone: 'video' | 'audio';
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  label: string,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(6, 9, 15, 0.95)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(232, 200, 75, 0.45)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, height / 2);
}

function drawAudioWaveform(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(6, 9, 15, 0.95)';
  ctx.fillRect(0, 0, width, height);

  if (peaks.length === 0) return;

  const midY = height / 2;
  const barW = width / peaks.length;
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, 'rgba(96, 165, 250, 0.55)');
  grad.addColorStop(0.5, 'rgba(147, 197, 253, 1)');
  grad.addColorStop(1, 'rgba(96, 165, 250, 0.55)');
  ctx.fillStyle = grad;

  for (let i = 0; i < peaks.length; i++) {
    const amplitude = peaks[i];
    const barHeight = Math.max(1.5, amplitude * (height - 4) * 0.9);
    const x = i * barW;
    const w = Math.max(1, barW - 0.5);
    ctx.fillRect(x, midY - barHeight / 2, w, barHeight);
  }
}

function applyFadeOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  alpha: number,
): void {
  if (alpha >= 1) return;
  ctx.fillStyle = `rgba(0,0,0,${(1 - alpha).toFixed(4)})`;
  ctx.fillRect(0, 0, width, height);
}

export function FadeCanvasPreview({
  objectUrl,
  peaks,
  trimStart,
  trimEnd,
  clipDuration,
  fadeDuration,
  direction,
  tone,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekTokenRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const timing = useMemo(
    () => getFadePreviewTiming(direction, trimStart, trimEnd, clipDuration, fadeDuration),
    [direction, trimStart, trimEnd, clipDuration, fadeDuration],
  );

  const alpha = useMemo(
    () => computeFadePreviewAlpha(direction, timing, fadeDuration),
    [direction, timing, fadeDuration],
  );

  useEffect(() => {
    if (tone !== 'video' || !objectUrl) return;
    const video = videoRef.current;
    if (!video) return;
    video.src = objectUrl;
    video.load();
  }, [tone, objectUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const drawAudio = () => {
      drawAudioWaveform(ctx, peaks ?? new Float32Array(0), PREVIEW_WIDTH, PREVIEW_HEIGHT);
      applyFadeOverlay(ctx, PREVIEW_WIDTH, PREVIEW_HEIGHT, alpha);
    };

    if (tone === 'audio') {
      drawAudio();
      return;
    }

    if (!objectUrl) {
      drawPlaceholder(ctx, PREVIEW_WIDTH, PREVIEW_HEIGHT, 'No video');
      applyFadeOverlay(ctx, PREVIEW_WIDTH, PREVIEW_HEIGHT, alpha);
      return;
    }

    const video = videoRef.current;
    if (!video) {
      ctx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
      return;
    }

    const token = ++seekTokenRef.current;

    const drawVideo = () => {
      if (token !== seekTokenRef.current) return;
      ctx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
      try {
        ctx.drawImage(video, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
      } catch {
        ctx.fillStyle = 'rgba(6, 9, 15, 0.95)';
        ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
      }
      applyFadeOverlay(ctx, PREVIEW_WIDTH, PREVIEW_HEIGHT, alpha);
    };

    const onSeeked = () => drawVideo();
    video.addEventListener('seeked', onSeeked);

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (video.readyState >= 2 && Math.abs(video.currentTime - timing.seekTime) < 0.05) {
        drawVideo();
      } else {
        video.currentTime = timing.seekTime;
      }
    });

    return () => {
      video.removeEventListener('seeked', onSeeked);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [tone, objectUrl, peaks, timing.seekTime, alpha]);

  return (
    <div
      className={`inspector-fade-canvas-preview inspector-fade-canvas-preview--${tone}`}
      aria-hidden="true"
    >
      {tone === 'video' && (
        <video ref={videoRef} muted playsInline preload="auto" hidden />
      )}
      <canvas
        ref={canvasRef}
        className="inspector-fade-canvas-preview__canvas"
        width={PREVIEW_WIDTH}
        height={PREVIEW_HEIGHT}
      />
      <span className="inspector-fade-preview-label">{Math.round(alpha * 100)}%</span>
    </div>
  );
}
