/**
 * WebGPU export compositor — letterboxed frame scaling for GPU video export.
 *
 * Renders VideoFrame → WebGPU canvas with aspect-preserved fit + fades.
 * The canvas can be passed directly to VideoEncoder via `new VideoFrame(canvas)`.
 */

import { PreviewEngine } from './previewEngine';
import { acquireGpuContext } from './gpuDevice';
import { adoptGpuDevice } from '../gpu-chores/device';
import type { TransitionRenderParams } from './transitions/types';
import { computeLetterboxUv } from './letterboxUv';

export {
  combineLetterboxWithLayerUv,
  computeLetterboxUv,
  uvRectToSourcePixels,
  type LetterboxUv,
} from './letterboxUv';

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

  applyFinishing(
    settings: import('../utils/finishing').FinishingSettings,
    opts?: { frameIndex?: number; colorManagement?: import('../utils/colorManagement').ColorManagementSettings },
  ): void {
    this.engine.applyFinishing(settings, opts);
  }

  get canvasPresentation(): import('../utils/colorManagement').CanvasPresentation {
    return this.engine.canvasPresentation;
  }

  readPqExportRgba(): Promise<Uint8Array | null> {
    return this.engine.readPqExportRgba();
  }

  /** @deprecated Use applyFinishing(). */
  applyColorGrade(settings: import('../utils/lut').ColorGradeSettings): void {
    this.engine.applyColorGrade(settings);
  }

  /** Ensure GPU work is complete before capturing the canvas for VideoEncoder. */
  async flush(): Promise<void> {
    await this.engine.flush();
  }

  destroy(): void {
    this.engine.destroy();
  }
}

export async function isWebGpuExportAvailable(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  try {
    // Goes through the shared context so this probe reuses (or seeds) the
    // one device the rest of the app uses, instead of requesting its own
    // adapter that would otherwise sit unused.
    const ctx = await acquireGpuContext();
    adoptGpuDevice(ctx.device);
    return !!ctx.adapter;
  } catch {
    return false;
  }
}
