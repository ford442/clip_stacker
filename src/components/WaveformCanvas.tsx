import { useEffect, useRef } from "react";

interface Props {
  peaks: Float32Array;
  /** Pixel height of the canvas element. Width fills the container via CSS. */
  height?: number;
}

/**
 * Renders a waveform using a gold gradient on a dark background.
 * The canvas is drawn at 2× DPR for sharpness, then scaled via CSS to fill its container.
 */
export function WaveformCanvas({ peaks, height = 54 }: Props) {
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

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = "rgba(8, 12, 24, 0.0)";
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (peaks.length === 0) return;

    const midY = cssHeight / 2;
    const barW = cssWidth / peaks.length;

    // Gold gradient (top → mid → top mirrored)
    const grad = ctx.createLinearGradient(0, 0, 0, cssHeight);
    grad.addColorStop(0, "rgba(201, 162, 39, 0.55)");
    grad.addColorStop(0.4, "rgba(232, 184, 75, 0.95)");
    grad.addColorStop(0.5, "rgba(255, 215, 80, 1.0)");
    grad.addColorStop(0.6, "rgba(232, 184, 75, 0.95)");
    grad.addColorStop(1, "rgba(201, 162, 39, 0.55)");

    ctx.fillStyle = grad;

    for (let i = 0; i < peaks.length; i++) {
      const amplitude = peaks[i]; // 0..1
      const barHeight = Math.max(1.5, amplitude * (cssHeight - 4) * 0.9);
      const x = i * barW;
      const w = Math.max(1, barW - 0.5);
      ctx.fillRect(x, midY - barHeight / 2, w, barHeight);
    }

    // Subtle centre line
    ctx.fillStyle = "rgba(255, 215, 80, 0.15)";
    ctx.fillRect(0, midY - 0.5, cssWidth, 1);
  }, [peaks, height]);

  return (
    <div ref={containerRef} className="waveform-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}
