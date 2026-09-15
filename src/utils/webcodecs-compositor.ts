/**
 * Canvas / WebGPU compositor setup and per-frame draw helpers for WebCodecs export.
 */

import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import { drawTextOverlays } from './canvas-renderer';
import { DEFAULT_FINISHING, type FinishingSettings } from './finishing';
import { buildPreviewCompositionPlan } from './previewComposition';
import { ExportCompositor, isWebGpuExportAvailable } from '../webgpu/exportCompositor';
import { TARGET_FPS } from './webcodecs-codec';

export type GpuCompositorKind = 'auto' | 'webgpu' | 'canvas';

export interface ResolvedCompositor {
  kind: 'webgpu' | 'canvas';
  gpuCompositor: ExportCompositor | null;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
}

export async function resolveCompositor(
  width: number,
  height: number,
  preference: GpuCompositorKind,
): Promise<ResolvedCompositor> {
  const useWebGpu =
    preference === 'webgpu' ||
    (preference === 'auto' && (await isWebGpuExportAvailable()));

  if (useWebGpu) {
    try {
      const gpuCompositor = await ExportCompositor.create(width, height);
      return {
        kind: 'webgpu',
        gpuCompositor,
        canvas: gpuCompositor.canvas,
        ctx: null,
      };
    } catch {
      if (preference === 'webgpu') throw new Error('WebGPU compositor unavailable');
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create 2D canvas for GPU export');
  return { kind: 'canvas', gpuCompositor: null, canvas, ctx };
}

/**
 * Rasterize solid text overlays on top of a composited decoder frame using the
 * same preview composition plan as the timeline export path.
 */
export class DecoderTextOverlayPass {
  private readonly exportCanvas: HTMLCanvasElement;
  private readonly exportCtx: CanvasRenderingContext2D;

  constructor(
    private readonly clips: Clip[],
    private readonly clipGroups: ClipGroup[],
    private readonly transitions: ClipTransition[],
    private readonly textOverlays: TextOverlay[],
    private readonly settings: ExportSettings,
    private readonly targetWidth: number,
    private readonly targetHeight: number,
  ) {
    this.exportCanvas = document.createElement('canvas');
    this.exportCanvas.width = targetWidth;
    this.exportCanvas.height = targetHeight;
    const ctx = this.exportCanvas.getContext('2d');
    if (!ctx) throw new Error('Could not create text overlay export canvas');
    this.exportCtx = ctx;
  }

  compositeFrame(
    compositor: ResolvedCompositor,
    globalTimeSec: number,
  ): HTMLCanvasElement {
    this.exportCtx.drawImage(compositor.canvas, 0, 0);
    const plan = buildPreviewCompositionPlan(
      this.clips,
      this.clipGroups,
      this.transitions,
      this.textOverlays,
      this.settings,
      globalTimeSec,
      this.targetHeight,
      this.targetWidth,
    );
    drawTextOverlays(this.exportCtx, plan);
    return this.exportCanvas;
  }
}

export async function captureCompositedFrame(
  compositor: ResolvedCompositor,
  overlayPass: DecoderTextOverlayPass | null,
  globalTimeSec: number,
  timestamp: number,
  durationUs: number,
): Promise<VideoFrame> {
  if (compositor.gpuCompositor) {
    await compositor.gpuCompositor.flush();
  }
  const frameCanvas = overlayPass
    ? overlayPass.compositeFrame(compositor, globalTimeSec)
    : compositor.canvas;
  return new VideoFrame(frameCanvas, {
    timestamp,
    duration: durationUs,
  });
}

/** Composite a decoded VideoFrame (decoder path) with letterbox + fades + grade. */
export function drawCompositedVideoFrame(
  compositor: ResolvedCompositor,
  frame: VideoFrame,
  elapsed: number,
  duration: number,
  clip: Clip,
  targetWidth: number,
  targetHeight: number,
  finishing: FinishingSettings,
  frameIndex?: number,
): void {
  if (compositor.kind === 'webgpu' && compositor.gpuCompositor) {
    compositor.gpuCompositor.renderFrame(
      frame,
      elapsed,
      duration,
      clip.videoFadeIn,
      clip.videoFadeOut,
    );
    compositor.gpuCompositor.applyFinishing(finishing, {
      frameIndex: frameIndex ?? 0,
    });
    return;
  }

  const ctx = compositor.ctx!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  const destRect = calculateLetterboxRect(
    frame.displayWidth || targetWidth,
    frame.displayHeight || targetHeight,
    targetWidth,
    targetHeight,
  );
  ctx.drawImage(frame, destRect.x, destRect.y, destRect.width, destRect.height);
  applyFadeOverlay(ctx, compositor.canvas, elapsed, duration, clip.videoFadeIn, clip.videoFadeOut);
}

export function drawBlackFrame(compositor: ResolvedCompositor, width: number, height: number): void {
  if (compositor.kind === 'webgpu' && compositor.gpuCompositor) {
    compositor.gpuCompositor.clearBlack();
    return;
  }
  compositor.ctx!.fillStyle = '#000';
  compositor.ctx!.fillRect(0, 0, width, height);
}

export function drawCompositedFrame(
  compositor: ResolvedCompositor,
  video: HTMLVideoElement,
  elapsed: number,
  duration: number,
  clip: Clip,
  targetWidth: number,
  targetHeight: number,
  finishing: FinishingSettings = DEFAULT_FINISHING,
  frameIndex?: number,
): void {
  if (compositor.kind === 'webgpu' && compositor.gpuCompositor) {
    const frame = new VideoFrame(video, { timestamp: Math.round(elapsed * 1_000_000) });
    compositor.gpuCompositor.renderFrame(
      frame,
      elapsed,
      duration,
      clip.videoFadeIn,
      clip.videoFadeOut,
    );
    frame.close();
    compositor.gpuCompositor.applyFinishing(finishing, {
      frameIndex: frameIndex ?? Math.max(0, Math.round(elapsed * TARGET_FPS)),
    });
    return;
  }

  const ctx = compositor.ctx!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  const destRect = calculateLetterboxRect(
    video.videoWidth || targetWidth,
    video.videoHeight || targetHeight,
    targetWidth,
    targetHeight,
  );
  ctx.drawImage(video, destRect.x, destRect.y, destRect.width, destRect.height);
  applyFadeOverlay(ctx, compositor.canvas, elapsed, duration, clip.videoFadeIn, clip.videoFadeOut);
}

export function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && !video.seeking) {
      resolve();
      return;
    }
    const onSeeked = () => { off(); resolve(); };
    const onError = () => { off(); reject(new Error('Video seek failed')); };
    const off = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

export function calculateLetterboxRect(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  const videoAspect = videoWidth / videoHeight;
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

  return {
    x: (canvasWidth - destWidth) / 2,
    y: (canvasHeight - destHeight) / 2,
    width: destWidth,
    height: destHeight,
  };
}

export function applyFadeOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  elapsed: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
): void {
  const alpha = computeFadeAlpha(elapsed, duration, fadeIn, fadeOut);
  if (alpha < 1) {
    ctx.fillStyle = `rgba(0,0,0,${(1 - alpha).toFixed(4)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

export function computeFadeAlpha(elapsed: number, duration: number, fadeIn: number, fadeOut: number): number {
  let alpha = 1;
  if (fadeIn > 0 && elapsed < fadeIn) alpha = Math.min(alpha, elapsed / fadeIn);
  if (fadeOut > 0 && elapsed > duration - fadeOut) {
    alpha = Math.min(alpha, (duration - elapsed) / fadeOut);
  }
  return Math.max(0, Math.min(1, alpha));
}
