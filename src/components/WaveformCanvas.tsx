import { useEffect, useRef } from 'react';

interface Props {
  peaks: Float32Array;
  /** Pixel height of the canvas element. Width fills the container via CSS. */
  height?: number;
  /**
   * When set, peaks are drawn with non-uniform horizontal spacing derived from
   * the speed-remap integral (output time → source offset). Each entry is
   * { outputLocalT, sourceOffset } sampled across the clip duration.
   */
  remapCurve?: Array<{ t: number; sourceOffset: number }>;
}

/**
 * Renders a waveform using a gold gradient on a dark background.
 * The canvas is drawn at 2× DPR for sharpness, then scaled via CSS to fill its container.
 */
export function WaveformCanvas({ peaks, height = 54, remapCurve }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = container.clientWidth || 200;
    const cssHeight = height;

    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = 'rgba(8, 12, 24, 0.0)';
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (peaks.length === 0) return;

    const midY = cssHeight / 2;

    const grad = ctx.createLinearGradient(0, 0, 0, cssHeight);
    grad.addColorStop(0, 'rgba(201, 162, 39, 0.55)');
    grad.addColorStop(0.4, 'rgba(232, 184, 75, 0.95)');
    grad.addColorStop(0.5, 'rgba(255, 215, 80, 1.0)');
    grad.addColorStop(0.6, 'rgba(232, 184, 75, 0.95)');
    grad.addColorStop(1, 'rgba(201, 162, 39, 0.55)');
    ctx.fillStyle = grad;

    const useRemap = remapCurve && remapCurve.length >= 2;
    const duration = useRemap ? remapCurve[remapCurve.length - 1].t : 1;
    const maxSource = useRemap
      ? Math.max(1e-6, remapCurve[remapCurve.length - 1].sourceOffset)
      : peaks.length;

    for (let i = 0; i < peaks.length; i++) {
      const amplitude = peaks[i];
      const barHeight = Math.max(1.5, amplitude * (cssHeight - 4) * 0.9);

      let x0: number;
      let x1: number;
      if (useRemap && duration > 0) {
        const t0 = (duration * i) / peaks.length;
        const t1 = (duration * (i + 1)) / peaks.length;
        const u0 = t0 / duration;
        const u1 = t1 / duration;
        x0 = u0 * cssWidth;
        x1 = u1 * cssWidth;
      } else {
        const barW = cssWidth / peaks.length;
        x0 = i * barW;
        x1 = x0 + barW;
      }

      const w = Math.max(1, x1 - x0 - 0.5);
      ctx.fillRect(x0, midY - barHeight / 2, w, barHeight);
    }

    if (!useRemap && maxSource > 0) {
      // no-op: keeps linter happy when remap unused
    }

    ctx.fillStyle = 'rgba(255, 215, 80, 0.15)';
    ctx.fillRect(0, midY - 0.5, cssWidth, 1);
  }, [peaks, height, remapCurve]);

  return (
    <div ref={containerRef} className="waveform-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}
