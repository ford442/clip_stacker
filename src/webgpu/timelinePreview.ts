/**
 * WebGPU timeline preview — renders transition pairs via the shared WGSL registry.
 */

import type { Clip } from '../types';
import { DEFAULT_FINISHING } from '../utils/finishing';
import { resolveTimelineFinishing } from '../utils/finishing';
import { isColorManagementActive } from '../utils/colorManagement';
import { grainFrameSeedFromTime } from '../utils/grain';
import { layerWarpDrawParams, transitionWarpParams } from '../utils/clipTransform';
import {
  buildPreviewCompositionPlan,
  captionPlanOptions,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
  type PreviewDeviceState,
  type TimelineCompositor,
  type TimelineRenderOptions,
} from '../utils/previewComposition';
import { ClipMediaPool, seekVideoTo } from '../utils/clipMediaPool';
import { previewMetrics } from '../utils/previewMetrics';
import { PreviewEngine, type LayerDraw } from './previewEngine';
import { captureStillFrame, captureVideoFrame } from './captureFrame';
import {
  onGpuDeviceLost,
  onGpuDeviceRecovered,
  onGpuDeviceRecoveryFailed,
} from './gpuDevice';
import type { TransitionRenderParams } from './transitions/types';
import {
  isGpuTransitionPair,
  letterboxForLayer,
  toNormalizedDestRect,
} from './timelineLayerDraw';

// Re-exported for backwards compatibility — the pool now lives in utils so the
// Canvas2D fallback compositor can share it without importing webgpu.
export { ClipMediaPool, seekVideoTo };

// The per-layer helpers are shared with the worker compositor
// (`workerTimelineRenderer.ts`).
export { toNormalizedDestRect } from './timelineLayerDraw';

async function prepareClipFrame(
  layer: PreviewClipLayer,
  clip: Clip,
  mediaPool: ClipMediaPool,
  options?: TimelineRenderOptions,
): Promise<VideoFrame | null> {
  const video = mediaPool.getVideo(clip);
  const seekStart = performance.now();
  await seekVideoTo(video, layer.sourceTime);
  if (options?.isCancelled?.()) return null;
  previewMetrics.recordSeek(performance.now() - seekStart);
  return captureVideoFrame(video);
}

interface ResolvedLayerFrame {
  frame: VideoFrame;
  /** Real `<video>` element (seek path) or a dimensions-only stand-in (decoder path). */
  video: HTMLVideoElement;
}

/**
 * Get a frame for `layer`/`clip`, preferring the injected decoder-cursor
 * `frameProvider` (export) and falling back to the `<video>` seek path
 * (always used by live preview, and by export for layers the provider can't
 * decode). Returns null when neither source can produce a frame.
 */
async function resolveLayerFrame(
  layer: PreviewClipLayer,
  clip: Clip,
  mediaPool: ClipMediaPool,
  options?: TimelineRenderOptions,
): Promise<ResolvedLayerFrame | null> {
  if (options?.frameProvider) {
    const frame = await options.frameProvider.getFrame(layer, clip);
    if (frame) {
      const video = { videoWidth: frame.displayWidth, videoHeight: frame.displayHeight } as HTMLVideoElement;
      return { frame, video };
    }
  }
  const frame = await prepareClipFrame(layer, clip, mediaPool, options);
  if (!frame) return null;
  return { frame, video: mediaPool.getVideo(clip) };
}


/**
 * WebGPU timeline compositor — renders a composition plan with multiple
 * video layers (base cuts, GPU transitions, PiP overlays).
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

  /** This engine draws with main's device, so main's registry is the one to watch. */
  onDeviceState(listener: (state: PreviewDeviceState, message?: string) => void): () => void {
    const unsubscribers = [
      onGpuDeviceLost((info) => listener('lost', info.message)),
      onGpuDeviceRecovered(() => listener('recovered')),
      onGpuDeviceRecoveryFailed((error) => listener('failed', error.message)),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
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

  resetFinishingTemporal(): void {
    this.engine.resetFinishingTemporal();
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
    const pendingLayers: LayerDraw[] = [];

    const flushPendingLayers = () => {
      if (pendingLayers.length === 0) return;
      this.engine.renderLayers([...pendingLayers]);
      for (const item of pendingLayers) item.videoFrame.close();
      pendingLayers.length = 0;
    };

    const queueLayer = (item: LayerDraw) => {
      pendingLayers.push(item);
      isFirstLayer = false;
    };

    for (let index = 0; index < clipLayers.length; index++) {
      if (options?.isCancelled?.()) {
        for (const item of pendingLayers) item.videoFrame.close();
        return;
      }

      const layer = clipLayers[index];
      const nextLayer = clipLayers[index + 1];

      if (
        nextLayer &&
        isGpuTransitionPair(layer, nextLayer) &&
        layer.crossfade &&
        nextLayer.crossfade
      ) {
        const outgoingClip = this.clipsById.get(layer.clipId);
        const incomingClip = this.clipsById.get(nextLayer.clipId);
        if (
          outgoingClip?.kind === 'video' &&
          incomingClip?.kind === 'video'
        ) {
          const fromResolved = await resolveLayerFrame(
            layer,
            outgoingClip,
            this.mediaPool,
            options,
          );
          const toResolved = await resolveLayerFrame(
            nextLayer,
            incomingClip,
            this.mediaPool,
            options,
          );
          drawnClipIds.add(layer.clipId);
          drawnClipIds.add(nextLayer.clipId);

          if (fromResolved && toResolved) {
            if (options?.isCancelled?.()) {
              fromResolved.frame.close();
              toResolved.frame.close();
              for (const item of pendingLayers) item.videoFrame.close();
              return;
            }

            const fromLetterbox = letterboxForLayer(
              layer,
              fromResolved.video,
              fromResolved.frame,
              plan,
            );
            const toLetterbox = letterboxForLayer(
              nextLayer,
              toResolved.video,
              toResolved.frame,
              plan,
            );

            const transitionParams: TransitionRenderParams = {
              progress: layer.crossfade.progress,
              fromUvScale: [
                fromLetterbox.uvScale[0],
                fromLetterbox.uvScale[1],
              ],
              fromUvOffset: [
                fromLetterbox.uvOffset[0],
                fromLetterbox.uvOffset[1],
              ],
              toUvScale: [toLetterbox.uvScale[0], toLetterbox.uvScale[1]],
              toUvOffset: [toLetterbox.uvOffset[0], toLetterbox.uvOffset[1]],
              destRect: { x: 0, y: 0, w: 1, h: 1 },
              custom: layer.crossfade.params,
              ...transitionWarpParams(layer, nextLayer),
              clear: isFirstLayer,
            };

            flushPendingLayers();
            this.engine.renderTransition(
              fromResolved.frame,
              toResolved.frame,
              layer.crossfade.type,
              transitionParams,
            );
            fromResolved.frame.close();
            toResolved.frame.close();
            isFirstLayer = false;
            index += 1;
            continue;
          }

          fromResolved?.frame.close();
          toResolved?.frame.close();
        }
      }

      const clip = this.clipsById.get(layer.clipId);
      const mediaUrl = layer.mediaObjectUrl;
      if (mediaUrl) {
        const video = this.mediaPool.getVideoForUrl(layer.clipId, mediaUrl);
        const seekStart = performance.now();
        await seekVideoTo(video, layer.sourceTime);
        if (options?.isCancelled?.()) {
          for (const item of pendingLayers) item.videoFrame.close();
          return;
        }
        previewMetrics.recordSeek(performance.now() - seekStart);
        drawnClipIds.add(layer.clipId);

        const frame = await captureVideoFrame(video);
        if (!frame) continue;
        if (options?.isCancelled?.()) {
          frame.close();
          for (const item of pendingLayers) item.videoFrame.close();
          return;
        }

        const { uvScale, uvOffset } = letterboxForLayer(
          layer,
          video,
          frame,
          plan,
        );

        queueLayer({
          videoFrame: frame,
          params: {
            elapsed: layer.localElapsed,
            duration: layer.clipDuration,
            fadeIn: 0,
            fadeOut: 0,
            opacity: layer.opacity,
            uvScale,
            uvOffset,
            key: layer.key,
            destRect: { x: 0, y: 0, w: 1, h: 1 },
            clear: isFirstLayer,
          },
        });
        continue;
      }

      if (!clip || clip.kind !== 'video') continue;

      let frame: VideoFrame | null = null;
      let videoWidth = plan.canvasWidth;
      let videoHeight = plan.canvasHeight;

      if (clip.stillImage) {
        const img = this.mediaPool.getStillImage(clip);
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          });
        }
        frame = await captureStillFrame(img);
        videoWidth = img.naturalWidth || videoWidth;
        videoHeight = img.naturalHeight || videoHeight;
      } else {
        const resolved = await resolveLayerFrame(layer, clip, this.mediaPool, options);
        if (options?.isCancelled?.()) {
          resolved?.frame.close();
          for (const item of pendingLayers) item.videoFrame.close();
          return;
        }
        if (resolved) {
          frame = resolved.frame;
          videoWidth = resolved.video.videoWidth || videoWidth;
          videoHeight = resolved.video.videoHeight || videoHeight;
        }
      }

      if (!frame) continue;
      if (options?.isCancelled?.()) {
        frame.close();
        for (const item of pendingLayers) item.videoFrame.close();
        return;
      }
      drawnClipIds.add(layer.clipId);

      const fakeVideo = { videoWidth, videoHeight } as HTMLVideoElement;
      const { uvScale, uvOffset } = letterboxForLayer(
        layer,
        fakeVideo,
        frame,
        plan,
      );

      const destRect =
        layer.kind === 'pip'
          ? toNormalizedDestRect(layer.rect, plan.canvasWidth, plan.canvasHeight)
          : { x: 0, y: 0, w: 1, h: 1 };

      queueLayer({
        videoFrame: frame,
        params: {
          elapsed: layer.localElapsed,
          duration: layer.clipDuration,
          fadeIn: 0,
          fadeOut: 0,
          opacity: layer.opacity,
          uvScale,
          uvOffset,
          ...layerWarpDrawParams(layer, destRect),
          key: layer.key,
          destRect,
          clear: isFirstLayer,
        },
      });
    }

    flushPendingLayers();

    if (isFirstLayer) {
      if (!options?.isCancelled?.()) {
        this.engine.clearToBlack();
      }
    }

    if (options?.isCancelled?.()) return;

    const finishing = resolveTimelineFinishing(options);
    const colorManagement = options?.colorManagement;
    if (finishing || isColorManagementActive(colorManagement)) {
      const frameIndex =
        options?.frameIndex ?? grainFrameSeedFromTime(plan.globalTime);
      this.engine.applyFinishing(finishing ?? DEFAULT_FINISHING, {
        frameIndex,
        colorManagement,
      });
    }

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
      captionPlanOptions(options),
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

  /** Ensure GPU work is complete before capturing the canvas for VideoEncoder. */
  async flush(): Promise<void> {
    await this.engine.flush();
  }

  get canvasPresentation() {
    return this.engine.canvasPresentation;
  }

  readPqExportRgba(): Promise<Uint8Array | null> {
    return this.engine.readPqExportRgba();
  }

  /**
   * Blit shader-filled text onto the WebGPU canvas (no 2D video copy).
   * Solid overlays and boxed shader overlays stay on the Canvas2D export path.
   */
  async compositeShaderTextOverlays(plan: PreviewCompositionPlan): Promise<void> {
    const { getTextFillRenderer } = await import('./text/textFill');
    const { createSingleOverlayGlyphMask } = await import('../utils/textMask');
    const renderer = await getTextFillRenderer();

    for (const layer of plan.layers) {
      if (layer.kind !== 'text') continue;
      const overlay = layer.overlay;
      if (!overlay?.text || overlay.fill !== 'shader') continue;

      const mask = createSingleOverlayGlyphMask(
        overlay,
        plan.globalTime,
        plan.canvasWidth,
        plan.canvasHeight,
      );
      const maskCacheKey = [
        overlay.id,
        overlay.text,
        overlay.font ?? '',
        overlay.fontsize,
        layer.x,
        layer.y,
        layer.opacity ?? 1,
        plan.canvasWidth,
        plan.canvasHeight,
      ].join(':');
      const filled = await renderer.render(mask, {
        time: plan.globalTime,
        shaderId: overlay.shaderId,
        params: overlay.shaderParams,
        colors: overlay.shaderColors,
        width: plan.canvasWidth,
        height: plan.canvasHeight,
        maskCacheKey,
      });
      this.engine.blitOverlayCanvas(filled);
    }
  }

  destroy(): void {
    this.mediaPool.destroy();
    this.engine.destroy();
  }
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

/** Expose the underlying preview engine for export compositing. */
export function getTimelinePreviewEngine(engine: TimelinePreviewEngine): PreviewEngine {
  return (engine as unknown as { engine: PreviewEngine }).engine;
}
