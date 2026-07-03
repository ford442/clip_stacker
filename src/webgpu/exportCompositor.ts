/**
 * WebGPU export compositor — letterboxed frame scaling for GPU video export.
 *
 * Renders VideoFrame → WebGPU canvas with aspect-preserved fit + fades.
 * The canvas can be passed directly to VideoEncoder via `new VideoFrame(canvas)`.
 */

import { PreviewEngine } from './previewEngine';
import type { TransitionRenderParams } from './transitions/types';

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

/** Multiply letterbox UV with per-layer Ken Burns / animation UV. */
export function combineLetterboxWithLayerUv(
  letterbox: LetterboxUv,
  layerUvScale: [number, number] | undefined,
  layerUvOffset: [number, number] | undefined,
): LetterboxUv {
  const kx = layerUvScale?.[0] ?? 1;
  const ky = layerUvScale?.[1] ?? 1;
  const ox = layerUvOffset?.[0] ?? 0;
  const oy = layerUvOffset?.[1] ?? 0;
  return {
    uvScale: [letterbox.uvScale[0] * kx, letterbox.uvScale[1] * ky],
    uvOffset: [
      letterbox.uvOffset[0] + ox * letterbox.uvScale[0],
      letterbox.uvOffset[1] + oy * letterbox.uvScale[1],
    ],
  };
}

/** Map normalized texture UV rect to pixel crop in the source image. */
export function uvRectToSourcePixels(
  srcWidth: number,
  srcHeight: number,
  uv: LetterboxUv,
): { sx: number; sy: number; sw: number; sh: number } {
  return {
    sx: uv.uvOffset[0] * srcWidth,
    sy: uv.uvOffset[1] * srcHeight,
    sw: uv.uvScale[0] * srcWidth,
    sh: uv.uvScale[1] * srcHeight,
  };
}

export class ExportCompositor {
  private engine: PreviewEngine;
  readonly canvas: HTMLCanvasElement;

  private constructor(engine: PreviewEngine, canvas: HTMLCanvasElement) {
    this.engine = engine;
    this.canvas = canvas;
  }

  /** Access underlying preview engine (LUT pass, transitions). */
  getPreviewEngine(): PreviewEngine {
    return this.engine;
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

  renderTransition(
    fromFrame: VideoFrame,
    toFrame: VideoFrame,
    transitionId: string,
    params: TransitionRenderParams,
  ): void {
    this.engine.renderTransition(fromFrame, toFrame, transitionId, params);
  }

  clearBlack(): void {
    this.engine.clearToBlack();
  }

  applyColorGrade(settings: import('../utils/lut').ColorGradeSettings): void {
    this.engine.applyColorGrade(settings);
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
