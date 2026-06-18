import type { Clip } from '../types';
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
} from '../utils/previewComposition';
import { computeLetterboxUv } from './exportCompositor';
import { PreviewEngine, type NormalizedDestRect } from './previewEngine';

const SEEK_TOLERANCE_SECONDS = 0.04;

/** Hidden video elements keyed by clip id — one decoder per source clip. */
export class ClipMediaPool {
  private readonly videos = new Map<string, HTMLVideoElement>();

  getVideo(clip: Clip): HTMLVideoElement {
    const existing = this.videos.get(clip.id);
    if (existing) {
      if (existing.src !== clip.objectUrl) {
        existing.src = clip.objectUrl;
      }
      return existing;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.src = clip.objectUrl;
    video.style.cssText =
      'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
    document.body.appendChild(video);
    this.videos.set(clip.id, video);
    return video;
  }

  remove(clipId: string): void {
    const video = this.videos.get(clipId);
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (video.parentElement) video.parentElement.removeChild(video);
    this.videos.delete(clipId);
  }

  destroy(): void {
    for (const clipId of [...this.videos.keys()]) {
      this.remove(clipId);
    }
  }

  pruneExcept(keepIds: ReadonlySet<string>): void {
    for (const clipId of [...this.videos.keys()]) {
      if (!keepIds.has(clipId)) {
        this.remove(clipId);
      }
    }
  }
}

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

export async function seekVideoTo(
  video: HTMLVideoElement,
  time: number,
): Promise<void> {
  const clamped = Math.max(0, time);
  if (Math.abs(video.currentTime - clamped) <= SEEK_TOLERANCE_SECONDS) return;

  video.pause();
  video.currentTime = clamped;

  await new Promise<void>((resolve) => {
    if (Math.abs(video.currentTime - clamped) <= SEEK_TOLERANCE_SECONDS) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
  });
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
export class TimelinePreviewEngine {
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
      }
    }
  }

  async renderPlan(plan: PreviewCompositionPlan): Promise<void> {
    const clipLayers = plan.layers.filter(
      (layer): layer is PreviewClipLayer =>
        layer.kind === 'base' || layer.kind === 'pip',
    );

    if (clipLayers.length === 0) {
      this.engine.clearToBlack();
      return;
    }

    let isFirstLayer = true;
    for (const layer of clipLayers) {
      const clip = this.clipsById.get(layer.clipId);
      if (!clip || clip.kind !== 'video') continue;

      const video = this.mediaPool.getVideo(clip);
      await seekVideoTo(video, layer.sourceTime);

      const frame = await captureVideoFrame(video);
      if (!frame) continue;

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
      this.engine.clearToBlack();
    }
  }

  syncClips(clips: Clip[]): void {
    this.clipsById.clear();
    for (const clip of clips) {
      this.clipsById.set(clip.id, clip);
    }
    this.mediaPool.pruneExcept(new Set(clips.map((clip) => clip.id)));
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
): Promise<PreviewCompositionPlan> {
  engine.syncClips(clips);
  const plan = buildPreviewCompositionPlan(
    clips,
    groups,
    transitions,
    overlays,
    settings,
    globalTime,
  );
  engine.resizeCanvas(plan.canvasWidth, plan.canvasHeight);
  await engine.renderPlan(plan);
  return plan;
}
