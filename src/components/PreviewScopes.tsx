import { useEffect, useRef } from 'react';
import type { ScopeData } from '../webgpu/previewWorkerProtocol';
import { VECTORSCOPE_SIZE } from '../gpu-chores/cpu/vectorscope';

/** Rendered size of each scope canvas (CSS px = device px; they are small). */
const WAVEFORM_WIDTH = 256;
const WAVEFORM_HEIGHT = 96;
const VECTORSCOPE_EDGE = 160;

/**
 * Waveform (256-bin Rec.709 luma histogram) + vectorscope (CbCr scatter) drawn
 * from the bins gpu-chores computed on the composed preview frame.
 *
 * Both are read-only overlays: the scopes never touch the preview canvas, and
 * when the worker posts nothing (toggles off, no GPU, `?no_gpu_compute`) they
 * simply render empty graticules.
 */
export function PreviewScopes({
  data,
  showWaveform,
  showVectorscope,
}: {
  data: ScopeData | null;
  showWaveform: boolean;
  showVectorscope: boolean;
}): JSX.Element | null {
  const waveformRef = useRef<HTMLCanvasElement | null>(null);
  const vectorRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas || !showWaveform) return;
    drawWaveform(canvas, data?.histogram ?? null);
  }, [data, showWaveform]);

  useEffect(() => {
    const canvas = vectorRef.current;
    if (!canvas || !showVectorscope) return;
    drawVectorscope(canvas, data?.vectorscope ?? null, data?.vectorscopeSize ?? VECTORSCOPE_SIZE);
  }, [data, showVectorscope]);

  if (!showWaveform && !showVectorscope) return null;

  return (
    <div className="preview-scopes" role="group" aria-label="Preview scopes">
      {showWaveform && (
        <figure className="preview-scope">
          <canvas
            ref={waveformRef}
            width={WAVEFORM_WIDTH}
            height={WAVEFORM_HEIGHT}
            aria-label="Luma waveform (256-bin Rec.709 histogram)"
          />
          <figcaption>Waveform</figcaption>
        </figure>
      )}
      {showVectorscope && (
        <figure className="preview-scope">
          <canvas
            ref={vectorRef}
            width={VECTORSCOPE_EDGE}
            height={VECTORSCOPE_EDGE}
            aria-label="Vectorscope (Rec.709 CbCr scatter)"
          />
          <figcaption>Vectorscope</figcaption>
        </figure>
      )}
    </div>
  );
}

/** Log-compress bin counts so a few huge bins don't flatten everything else. */
function normalize(bins: Uint32Array): { scale: number } {
  let peak = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i]! > peak) peak = bins[i]!;
  return { scale: peak > 0 ? 1 / Math.log1p(peak) : 0 };
}

export function drawWaveform(canvas: HTMLCanvasElement, bins: Uint32Array | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, width, height);

  // IRE-ish graticule at 0 / 25 / 50 / 75 / 100 %.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round((i / 4) * (height - 1)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (!bins || bins.length === 0) return;
  const { scale } = normalize(bins);
  if (scale === 0) return;

  ctx.fillStyle = '#8fd3ff';
  const barWidth = width / bins.length;
  for (let i = 0; i < bins.length; i++) {
    const value = Math.log1p(bins[i]!) * scale;
    const barHeight = value * height;
    ctx.fillRect(i * barWidth, height - barHeight, Math.max(1, barWidth), barHeight);
  }
}

export function drawVectorscope(
  canvas: HTMLCanvasElement,
  bins: Uint32Array | null,
  binSize: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, width, height);

  // Graticule: neutral centre + 100 % saturation ring.
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) / 2 - 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(width / 2, 0);
  ctx.lineTo(width / 2, height);
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  if (!bins || bins.length < binSize * binSize) return;
  const { scale } = normalize(bins);
  if (scale === 0) return;

  const cellW = width / binSize;
  const cellH = height / binSize;
  for (let v = 0; v < binSize; v++) {
    for (let u = 0; u < binSize; u++) {
      const count = bins[v * binSize + u]!;
      if (count === 0) continue;
      const alpha = Math.min(1, Math.log1p(count) * scale);
      ctx.fillStyle = `rgba(143, 211, 255, ${alpha.toFixed(3)})`;
      // Cb grows to the right; Cr grows upward, so rows are drawn bottom-up.
      ctx.fillRect(u * cellW, height - (v + 1) * cellH, Math.max(1, cellW), Math.max(1, cellH));
    }
  }
}
