/**
 * WebGPU timeline preview — renders transition pairs via the shared WGSL registry.
 */

import type { Clip, ClipTransition, TextOverlay } from '../types';
import type { ColorGradeSettings } from '../utils/lut';
import { projectHasKeyframeAnimation } from '../utils/animatedLayout';
import {
  buildPreviewCompositionPlan,
  type PreviewClipLayer,
  type PreviewCompositionPlan,
  type TimelineCompositor,
  type TimelineRenderOptions,
} from '../utils/previewComposition';
import { ClipMediaPool, seekVideoTo } from '../utils/clipMediaPool';
import { previewMetrics } from '../utils/previewMetrics';
import {
  combineLetterboxWithLayerUv,
  computeLetterboxUv,
} from './exportCompositor';
import { PreviewEngine, type NormalizedDestRect } from './previewEngine';
import { isRegisteredTransitionType } from './transitions/registry';
import type { TransitionRenderParams } from './transitions/types';

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

async function captureStillFrame(
  img: HTMLImageElement,
): Promise<VideoFrame | null> {
  if (!img.complete || img.naturalWidth <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return new VideoFrame(canvas, { timestamp: 0 });
  } catch {
    return null;
  }
}

function isGpuTransitionPair(
  outgoing: PreviewClipLayer,
  incoming: PreviewClipLayer,
): boolean {
  if (!outgoing.crossfade || !incoming.crossfade) return false;
  if (outgoing.crossfade.role !== 'outgoing' || incoming.crossfade.role !== 'incoming') {
    return false;
  }
  if (outgoing.clipId !== outgoing.crossfade.outgoingClipId) return false;
  if (incoming.clipId !== incoming.crossfade.incomingClipId) return false;
  return isRegisteredTransitionType(outgoing.crossfade.type);
}

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

function letterboxForLayer(
  layer: PreviewClipLayer,
  video: HTMLVideoElement,
  frame: VideoFrame,
  plan: PreviewCompositionPlan,
): { uvScale: [number, number]; uvOffset: [number, number] } {
  const destWidth =
    layer.kind === 'pip' ? layer.rect.width : plan.canvasWidth;
  const destHeight =
    layer.kind === 'pip' ? layer.rect.height : plan.canvasHeight;
  const videoWidth = video.videoWidth || frame.displayWidth || destWidth;
  const videoHeight =
    video.videoHeight || frame.displayHeight || destHeight;
  const letterbox = computeLetterboxUv(
    videoWidth,
    videoHeight,
    destWidth,
    destHeight,
  );
  return combineLetterboxWithLayerUv(letterbox, layer.uvScale, layer.uvOffset);
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

    for (let index = 0; index < clipLayers.length; index++) {
      if (options?.isCancelled?.()) return;

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
          const outgoingVideo = this.mediaPool.getVideo(outgoingClip);
          const incomingVideo = this.mediaPool.getVideo(incomingClip);
          const fromFrame = await prepareClipFrame(
            layer,
            outgoingClip,
            this.mediaPool,
            options,
          );
          const toFrame = await prepareClipFrame(
            nextLayer,
            incomingClip,
            this.mediaPool,
            options,
          );
          drawnClipIds.add(layer.clipId);
          drawnClipIds.add(nextLayer.clipId);

          if (fromFrame && toFrame) {
            if (options?.isCancelled?.()) {
              fromFrame.close();
              toFrame.close();
              return;
            }

            const fromLetterbox = letterboxForLayer(
              layer,
              outgoingVideo,
              fromFrame,
              plan,
            );
            const toLetterbox = letterboxForLayer(
              nextLayer,
              incomingVideo,
              toFrame,
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
              clear: isFirstLayer,
            };

            this.engine.renderTransition(
              fromFrame,
              toFrame,
              layer.crossfade.type,
              transitionParams,
            );
            fromFrame.close();
            toFrame.close();
            isFirstLayer = false;
            index += 1;
            continue;
          }

          fromFrame?.close();
          toFrame?.close();
        }
      }

      const clip = this.clipsById.get(layer.clipId);
      const mediaUrl = layer.mediaObjectUrl;
      if (mediaUrl) {
        const video = this.mediaPool.getVideoForUrl(layer.clipId, mediaUrl);
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

        const { uvScale, uvOffset } = letterboxForLayer(
          layer,
          video,
          frame,
          plan,
        );

        this.engine.renderLayer(frame, {
          elapsed: layer.localElapsed,
          duration: layer.clipDuration,
          fadeIn: 0,
          fadeOut: 0,
          opacity: layer.opacity,
          uvScale,
          uvOffset,
          destRect: { x: 0, y: 0, w: 1, h: 1 },
          clear: isFirstLayer,
        });
        frame.close();
        isFirstLayer = false;
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
        const video = this.mediaPool.getVideo(clip);
        const seekStart = performance.now();
        await seekVideoTo(video, layer.sourceTime);
        if (options?.isCancelled?.()) return;
        previewMetrics.recordSeek(performance.now() - seekStart);
        frame = await captureVideoFrame(video);
        videoWidth = video.videoWidth || videoWidth;
        videoHeight = video.videoHeight || videoHeight;
      }

      if (!frame) continue;
      if (options?.isCancelled?.()) {
        frame.close();
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

    if (options?.colorGrade) {
      this.engine.applyColorGrade(options.colorGrade);
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

export function shouldUseTimelinePreview(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
): boolean {
  if (clips.length === 0) return false;
  if (projectHasKeyframeAnimation(clips, textOverlays)) return true;
  if (clips.some((clip) => clip.stillImage)) return true;
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

/** Expose the underlying preview engine for export compositing. */
export function getTimelinePreviewEngine(engine: TimelinePreviewEngine): PreviewEngine {
  return (engine as unknown as { engine: PreviewEngine }).engine;
}

// ---------------------------------------------------------------------------
// WorkerTimelineRenderer — GPU-only compositor for the off-thread worker path.
//
// Unlike TimelinePreviewEngine, this class never touches the DOM or a media
// pool.  It receives pre-captured VideoFrame objects (transferred from the
// main thread) and renders them directly to the OffscreenCanvas via the
// shared PreviewEngine.
// ---------------------------------------------------------------------------

export interface CapturedFrameEntry {
  clipId: string;
  role: string;
  frame: VideoFrame;
  videoWidth: number;
  videoHeight: number;
}

export class WorkerTimelineRenderer {
  private readonly engine: PreviewEngine;
  private readonly canvas: OffscreenCanvas;

  constructor(engine: PreviewEngine, canvas: OffscreenCanvas) {
    this.engine = engine;
    this.canvas = canvas;
  }

  static async create(canvas: OffscreenCanvas): Promise<WorkerTimelineRenderer> {
    const engine = await PreviewEngine.create(canvas);
    return new WorkerTimelineRenderer(engine, canvas);
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

  /**
   * Render a composition plan using pre-captured frames supplied by the main
   * thread.  All VideoFrames are closed after use.  Caller must not access
   * them after this method returns.
   */
  async renderFromFrames(
    plan: PreviewCompositionPlan,
    frames: CapturedFrameEntry[],
    colorGrade?: ColorGradeSettings,
    isCancelled?: () => boolean,
  ): Promise<void> {
    if (isCancelled?.()) {
      frames.forEach((f) => f.frame.close());
      return;
    }

    const clipLayers = plan.layers.filter(
      (layer): layer is PreviewClipLayer =>
        layer.kind === 'base' || layer.kind === 'pip',
    );

    if (clipLayers.length === 0) {
      frames.forEach((f) => f.frame.close());
      if (!isCancelled?.()) this.engine.clearToBlack();
      return;
    }

    // Build a lookup from "clipId:role" → captured frame entry.
    const frameMap = new Map<string, CapturedFrameEntry>();
    for (const entry of frames) {
      frameMap.set(`${entry.clipId}:${entry.role}`, entry);
    }

    let isFirstLayer = true;

    for (let index = 0; index < clipLayers.length; index++) {
      if (isCancelled?.()) {
        // Close any remaining frames.
        frameMap.forEach((e) => e.frame.close());
        return;
      }

      const layer = clipLayers[index];
      const nextLayer = clipLayers[index + 1];

      // GPU transition pair: outgoing + incoming layers share a crossfade.
      if (
        nextLayer &&
        isGpuTransitionPair(layer, nextLayer) &&
        layer.crossfade &&
        nextLayer.crossfade
      ) {
        const fromEntry = frameMap.get(`${layer.clipId}:${layer.crossfade.role}`);
        const toEntry = frameMap.get(`${nextLayer.clipId}:${nextLayer.crossfade.role}`);

        if (fromEntry && toEntry) {
          if (isCancelled?.()) {
            fromEntry.frame.close();
            toEntry.frame.close();
            frameMap.forEach((e) => e.frame.close());
            return;
          }

          const fakeFromVideo = { videoWidth: fromEntry.videoWidth, videoHeight: fromEntry.videoHeight } as HTMLVideoElement;
          const fakeToVideo = { videoWidth: toEntry.videoWidth, videoHeight: toEntry.videoHeight } as HTMLVideoElement;

          const fromLetterbox = letterboxForLayer(layer, fakeFromVideo, fromEntry.frame, plan);
          const toLetterbox = letterboxForLayer(nextLayer, fakeToVideo, toEntry.frame, plan);

          const transitionParams: TransitionRenderParams = {
            progress: layer.crossfade.progress,
            fromUvScale: [fromLetterbox.uvScale[0], fromLetterbox.uvScale[1]],
            fromUvOffset: [fromLetterbox.uvOffset[0], fromLetterbox.uvOffset[1]],
            toUvScale: [toLetterbox.uvScale[0], toLetterbox.uvScale[1]],
            toUvOffset: [toLetterbox.uvOffset[0], toLetterbox.uvOffset[1]],
            destRect: { x: 0, y: 0, w: 1, h: 1 },
            custom: layer.crossfade.params,
            clear: isFirstLayer,
          };

          this.engine.renderTransition(fromEntry.frame, toEntry.frame, layer.crossfade.type, transitionParams);
          fromEntry.frame.close();
          toEntry.frame.close();
          frameMap.delete(`${layer.clipId}:${layer.crossfade.role}`);
          frameMap.delete(`${nextLayer.clipId}:${nextLayer.crossfade.role}`);
          isFirstLayer = false;
          index += 1;
          continue;
        }

        fromEntry?.frame.close();
        toEntry?.frame.close();
        if (fromEntry) frameMap.delete(`${layer.clipId}:${layer.crossfade.role}`);
        if (toEntry) frameMap.delete(`${nextLayer.clipId}:${nextLayer.crossfade.role}`);
      }

      const role = layer.crossfade?.role ?? 'base';
      const entry = frameMap.get(`${layer.clipId}:${role}`) ?? frameMap.get(`${layer.clipId}:base`);
      if (!entry) continue;

      frameMap.delete(`${layer.clipId}:${role}`);
      frameMap.delete(`${layer.clipId}:base`);

      if (isCancelled?.()) {
        entry.frame.close();
        frameMap.forEach((e) => e.frame.close());
        return;
      }

      const fakeVideo = { videoWidth: entry.videoWidth, videoHeight: entry.videoHeight } as HTMLVideoElement;
      const { uvScale, uvOffset } = letterboxForLayer(layer, fakeVideo, entry.frame, plan);
      const destRect =
        layer.kind === 'pip'
          ? toNormalizedDestRect(layer.rect, plan.canvasWidth, plan.canvasHeight)
          : { x: 0, y: 0, w: 1, h: 1 };

      this.engine.renderLayer(entry.frame, {
        elapsed: layer.localElapsed,
        duration: layer.clipDuration,
        fadeIn: layer.kind === 'base' ? (this.getClipFadeIn(layer)) : 0,
        fadeOut: layer.kind === 'base' ? (this.getClipFadeOut(layer)) : 0,
        opacity: layer.opacity,
        uvScale,
        uvOffset,
        destRect,
        clear: isFirstLayer,
      });
      entry.frame.close();
      isFirstLayer = false;
    }

    // Close any frames not consumed (e.g. still-image layers not in plan).
    frameMap.forEach((e) => e.frame.close());

    if (isFirstLayer && !isCancelled?.()) {
      this.engine.clearToBlack();
    }

    if (!isCancelled?.() && colorGrade) {
      this.engine.applyColorGrade(colorGrade);
    }
  }

  private getClipFadeIn(layer: PreviewClipLayer): number {
    // Fade values are baked into layer.opacity by the composition planner;
    // pass 0 to avoid double-fading in the shader.
    return 0;
  }

  private getClipFadeOut(layer: PreviewClipLayer): number {
    return 0;
  }

  destroy(): void {
    this.engine.destroy();
  }
}
