/**
 * WebGPU export compositor — letterboxed frame scaling for GPU video export.
 *
 * Renders VideoFrame → WebGPU canvas with aspect-preserved fit + fades.
 * The canvas can be passed directly to VideoEncoder via `new VideoFrame(canvas)`.
 */

import { PreviewEngine } from './previewEngine';

export interface LetterboxUv {
  uvScale: [number, number];
  uvOffset: [number, number];
}

export function computeLetterboxUv(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): LetterboxUv {
  const safeVideoWidth = Math.max(1, videoWidth);
  const safeVideoHeight = Math.max(1, videoHeight);
  const videoAspect = safeVideoWidth / safeVideoHeight;
  const canvasAspect = canvasWidth / canvasHeight;

  let destWidth: number;
  let destHeight: number;
  if (videoAspect > canvasAspect) {
    destWidth = canvasWidth;
    destHeight = canvasWidth / videoAspect;
  } else {
    destHeight = canvasHeight;
    destWidth = canvasHeight * videoAspect;
  }

  const x = (canvasWidth - destWidth) / 2;
  const y = (canvasHeight - destHeight) / 2;

  return {
    uvScale: [destWidth / canvasWidth, destHeight / canvasHeight],
    uvOffset: [x / canvasWidth, y / canvasHeight],
  };
}

export class ExportCompositor {
  private engine: PreviewEngine;
  readonly canvas: HTMLCanvasElement;

  private constructor(engine: PreviewEngine, canvas: HTMLCanvasElement) {
    this.engine = engine;
    this.canvas = canvas;
  }

  static async create(width: number, height: number): Promise<ExportCompositor> {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const engine = await PreviewEngine.create(canvas);
    return new ExportCompositor(engine, canvas);
  }

  renderFrame(
    videoFrame: VideoFrame,
    elapsed: number,
    duration: number,
    fadeIn: number,
    fadeOut: number,
  ): void {
    const { uvScale, uvOffset } = computeLetterboxUv(
      videoFrame.displayWidth || this.canvas.width,
      videoFrame.displayHeight || this.canvas.height,
      this.canvas.width,
      this.canvas.height,
    );
    this.engine.renderFrame(videoFrame, elapsed, duration, fadeIn, fadeOut, 1, uvScale, uvOffset);
  }

  clearBlack(): void {
    this.engine.clearToBlack();
  }

  destroy(): void {
    this.engine.destroy();
  }
}

export async function isWebGpuExportAvailable(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return !!adapter;
  } catch {
    return false;
  }
}
