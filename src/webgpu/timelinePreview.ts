import type { Clip } from '../types';
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
  type TimelineCompositor,
  type TimelineRenderOptions,
} from '../utils/previewComposition';
import { ClipMediaPool, seekVideoTo } from '../utils/clipMediaPool';
import { previewMetrics } from '../utils/previewMetrics';
import { computeLetterboxUv } from './exportCompositor';
import { PreviewEngine, type NormalizedDestRect } from './previewEngine';

// Re-exported for backwards compatibility — the pool now lives in utils so the
// Canvas2D fallback compositor can share it without importing webgpu.
export { ClipMediaPool, seekVideoTo };

export function toNormalizedDestRect(
  rect: PreviewClipLayer['rect'],
  canvasWidth: number,
  canvasHeight: number,
): NormalizedDestRect {
  return {
    x: rect.x / canvasWidth,
    y: rect.y / canvasHeight,
    w: rect.width / canvasWidth,
    h: rect.height / canvasHeight,
  };
}

async function captureVideoFrame(
  video: HTMLVideoElement,
): Promise<VideoFrame | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  try {
    return new VideoFrame(video);
  } catch {
    return null;
  }
}

/**
 * WebGPU timeline compositor — renders a composition plan with multiple
 * video layers (base cuts, dissolves, PiP overlays).
 */
export class TimelinePreviewEngine implements TimelineCompositor {
  private readonly engine: PreviewEngine;
  private readonly mediaPool: ClipMediaPool;
  private readonly canvas: HTMLCanvasElement;
  private readonly clipsById: Map<string, Clip>;

  private constructor(
    engine: PreviewEngine,
    mediaPool: ClipMediaPool,
    canvas: HTMLCanvasElement,
    clips: Clip[],
  ) {
    this.engine = engine;
    this.mediaPool = mediaPool;
    this.canvas = canvas;
    this.clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  }

  static async create(
    canvas: HTMLCanvasElement,
    clips: Clip[],
  ): Promise<TimelinePreviewEngine> {
    const engine = await PreviewEngine.create(canvas);
    return new TimelinePreviewEngine(engine, new ClipMediaPool(), canvas, clips);
  }

  resizeCanvas(width: number, height: number): void {
    if (width > 0 && height > 0) {
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.engine.resize();
      }
    }
  }

  async renderPlan(
    plan: PreviewCompositionPlan,
    options?: TimelineRenderOptions,
  ): Promise<void> {
    if (options?.isCancelled?.()) return;

    const clipLayers = plan.layers.filter(
      (layer): layer is PreviewClipLayer =>
        layer.kind === 'base' || layer.kind === 'pip',
    );

    if (clipLayers.length === 0) {
      if (!options?.isCancelled?.()) {
        this.engine.clearToBlack();
      }
      return;
    }

    const drawnClipIds = new Set<string>();
    let isFirstLayer = true;
    for (const layer of clipLayers) {
      if (options?.isCancelled?.()) return;

      const clip = this.clipsById.get(layer.clipId);
      if (!clip || clip.kind !== 'video') continue;

      const video = this.mediaPool.getVideo(clip);
      const seekStart = performance.now();
      await seekVideoTo(video, layer.sourceTime);
      if (options?.isCancelled?.()) return;
      previewMetrics.recordSeek(performance.now() - seekStart);
      drawnClipIds.add(layer.clipId);

      const frame = await captureVideoFrame(video);
      if (!frame) continue;
      if (options?.isCancelled?.()) {
        frame.close();
        return;
      }

      const destWidth =
        layer.kind === 'pip' ? layer.rect.width : plan.canvasWidth;
      const destHeight =
        layer.kind === 'pip' ? layer.rect.height : plan.canvasHeight;
      const videoWidth = video.videoWidth || frame.displayWidth || destWidth;
      const videoHeight =
        video.videoHeight || frame.displayHeight || destHeight;
      const { uvScale, uvOffset } = computeLetterboxUv(
        videoWidth,
        videoHeight,
        destWidth,
        destHeight,
      );

      const destRect =
        layer.kind === 'pip'
          ? toNormalizedDestRect(layer.rect, plan.canvasWidth, plan.canvasHeight)
          : { x: 0, y: 0, w: 1, h: 1 };

      this.engine.renderLayer(frame, {
        elapsed: layer.localElapsed,
        duration: layer.clipDuration,
        fadeIn: 0,
        fadeOut: 0,
        opacity: layer.opacity,
        uvScale,
        uvOffset,
        destRect,
        clear: isFirstLayer,
      });
      frame.close();
      isFirstLayer = false;
    }

    if (isFirstLayer) {
      if (!options?.isCancelled?.()) {
        this.engine.clearToBlack();
      }
    }

    if (options?.isCancelled?.()) return;

    // Cap live decoders, protecting the clips drawn this frame (those nearest
    // the playhead), and report pool occupancy for dev metrics.
    this.mediaPool.enforceBudget(drawnClipIds);
    previewMetrics.setDecoderCount(this.mediaPool.size, this.mediaPool.limit);
  }

  /** Sync clips, build the plan for `globalTime`, and composite it (WebGPU). */
  async renderTimelineFrame(
    clips: Clip[],
    groups: Parameters<typeof buildPreviewCompositionPlan>[1],
    transitions: Parameters<typeof buildPreviewCompositionPlan>[2],
    overlays: Parameters<typeof buildPreviewCompositionPlan>[3],
    settings: Parameters<typeof buildPreviewCompositionPlan>[4],
    globalTime: number,
    options?: TimelineRenderOptions,
  ): Promise<PreviewCompositionPlan> {
    this.syncClips(clips);
    const plan = buildPreviewCompositionPlan(
      clips,
      groups,
      transitions,
      overlays,
      settings,
      globalTime,
      options?.maxHeight,
      options?.maxWidth,
    );
    if (options?.isCancelled?.()) return plan;
    this.resizeCanvas(plan.canvasWidth, plan.canvasHeight);
    if (options?.isCancelled?.()) return plan;
    await this.renderPlan(plan, options);
    return plan;
  }

  syncClips(clips: Clip[]): void {
    this.clipsById.clear();
    for (const clip of clips) {
      this.clipsById.set(clip.id, clip);
    }
    this.mediaPool.pruneExcept(new Set(clips.map((clip) => clip.id)));
  }

  pauseDecoders(): void {
    this.mediaPool.pauseAll();
  }

  destroy(): void {
    this.mediaPool.destroy();
    this.engine.destroy();
  }
}

export function shouldUseTimelinePreview(clips: Clip[]): boolean {
  if (clips.length === 0) return false;
  const hasVideo = clips.some((clip) => clip.kind === 'video');
  if (!hasVideo) return false;
  return (
    clips.length >= 2 || clips.some((clip) => (clip.layerIndex ?? 0) > 0)
  );
}

export async function renderTimelinePreviewFrame(
  engine: TimelinePreviewEngine,
  clips: Clip[],
  groups: Parameters<typeof buildPreviewCompositionPlan>[1],
  transitions: Parameters<typeof buildPreviewCompositionPlan>[2],
  overlays: Parameters<typeof buildPreviewCompositionPlan>[3],
  settings: Parameters<typeof buildPreviewCompositionPlan>[4],
  globalTime: number,
  options?: TimelineRenderOptions,
): Promise<PreviewCompositionPlan> {
  return engine.renderTimelineFrame(
    clips,
    groups,
    transitions,
    overlays,
    settings,
    globalTime,
    options,
  );
}
