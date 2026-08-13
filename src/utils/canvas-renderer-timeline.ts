/**
 * Canvas2D timeline preview compositor — the fallback used when WebGPU is
 * unavailable or over the layer budget. Supports arbitrary `globalTime` seeks.
 */

import type { Clip } from "../types";
import {
  buildPreviewCompositionPlan,
  type PreviewCompositionPlan,
  type TimelineCompositor,
  type TimelineRenderOptions,
} from "./previewComposition";
import { ClipMediaPool, seekVideoTo } from "./clipMediaPool";
import { previewMetrics } from "./previewMetrics";
import { compositeFrame } from "./canvas-renderer-compositor";
import type { FrameSource } from "./canvas-renderer-types";

export class TimelineCanvas2DRenderer implements TimelineCompositor {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly mediaPool: ClipMediaPool;
  private clipsById: Map<string, Clip>;

  private constructor(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    mediaPool: ClipMediaPool,
    clips: Clip[],
  ) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.mediaPool = mediaPool;
    this.clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  }

  static create(
    canvas: HTMLCanvasElement,
    clips: Clip[],
  ): TimelineCanvas2DRenderer {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("TimelineCanvas2DRenderer: 2D context unavailable");
    }
    return new TimelineCanvas2DRenderer(
      ctx,
      canvas,
      new ClipMediaPool(),
      clips,
    );
  }

  resizeCanvas(width: number, height: number): void {
    if (width > 0 && height > 0) {
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
    }
  }

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

  async renderPlan(
    plan: PreviewCompositionPlan,
    options?: TimelineRenderOptions,
  ): Promise<void> {
    if (options?.isCancelled?.()) return;

    const frameSources = new Map<string, FrameSource>();
    const drawnClipIds = new Set<string>();

    for (const layer of plan.layers) {
      if (options?.isCancelled?.()) return;
      if (layer.kind === "text") continue;

      if (layer.mediaObjectUrl) {
        const video = this.mediaPool.getVideoForUrl(
          layer.clipId,
          layer.mediaObjectUrl,
        );
        const seekStart = performance.now();
        await seekVideoTo(video, layer.sourceTime);
        if (options?.isCancelled?.()) return;
        previewMetrics.recordSeek(performance.now() - seekStart);
        drawnClipIds.add(layer.clipId);
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;

        frameSources.set(layer.clipId, {
          image: video,
          width: video.videoWidth,
          height: video.videoHeight,
        });
        continue;
      }

      const clip = this.clipsById.get(layer.clipId);
      if (!clip || clip.kind !== "video") continue;

      if (clip.stillImage) {
        const img = this.mediaPool.getStillImage(clip);
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          });
        }
        if (img.naturalWidth <= 0) continue;
        drawnClipIds.add(layer.clipId);
        frameSources.set(layer.clipId, {
          image: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
        continue;
      }

      const video = this.mediaPool.getVideo(clip);
      const seekStart = performance.now();
      await seekVideoTo(video, layer.sourceTime);
      if (options?.isCancelled?.()) return;
      previewMetrics.recordSeek(performance.now() - seekStart);
      drawnClipIds.add(layer.clipId);
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;

      frameSources.set(layer.clipId, {
        image: video,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    }

    if (options?.isCancelled?.()) return;
    compositeFrame(this.ctx, plan, frameSources);

    // Cap live decoders, protecting the clips drawn this frame (those nearest
    // the playhead), and report pool occupancy for dev metrics.
    this.mediaPool.enforceBudget(drawnClipIds);
    previewMetrics.setDecoderCount(this.mediaPool.size, this.mediaPool.limit);
  }

  syncClips(clips: Clip[]): void {
    this.clipsById = new Map(clips.map((clip) => [clip.id, clip]));
    this.mediaPool.pruneExcept(new Set(clips.map((clip) => clip.id)));
  }

  pauseDecoders(): void {
    this.mediaPool.pauseAll();
  }

  destroy(): void {
    this.mediaPool.destroy();
  }
}
