import { DEFAULT_FINISHING, type FinishingSettings } from '../utils/finishing';
import {
  isColorManagementActive,
  type ColorManagementSettings,
} from '../utils/colorManagement';
import { grainFrameSeedFromTime } from '../utils/grain';
import { layerWarpDrawParams, transitionWarpParams } from '../utils/clipTransform';
import type { PreviewClipLayer, PreviewCompositionPlan } from '../utils/previewComposition';
import { PreviewEngine, type LayerDraw } from './previewEngine';
import type { TransitionRenderParams } from './transitions/types';
import {
  isGpuTransitionPair,
  letterboxForLayer,
  toNormalizedDestRect,
} from './timelineLayerDraw';

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
    finishing?: FinishingSettings,
    isCancelled?: () => boolean,
    frameIndex?: number,
    colorManagement?: ColorManagementSettings,
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
    const pendingLayers: LayerDraw[] = [];
    const flushPendingLayers = () => {
      if (pendingLayers.length === 0) return;
      this.engine.renderLayers([...pendingLayers]);
      for (const item of pendingLayers) item.videoFrame.close();
      pendingLayers.length = 0;
    };

    for (let index = 0; index < clipLayers.length; index++) {
      if (isCancelled?.()) {
        for (const item of pendingLayers) item.videoFrame.close();
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
            for (const item of pendingLayers) item.videoFrame.close();
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
            ...transitionWarpParams(layer, nextLayer),
            clear: isFirstLayer,
          };

          flushPendingLayers();
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
        for (const item of pendingLayers) item.videoFrame.close();
        frameMap.forEach((e) => e.frame.close());
        return;
      }

      const fakeVideo = { videoWidth: entry.videoWidth, videoHeight: entry.videoHeight } as HTMLVideoElement;
      const { uvScale, uvOffset } = letterboxForLayer(layer, fakeVideo, entry.frame, plan);
      const destRect =
        layer.kind === 'pip'
          ? toNormalizedDestRect(layer.rect, plan.canvasWidth, plan.canvasHeight)
          : { x: 0, y: 0, w: 1, h: 1 };

      pendingLayers.push({
        videoFrame: entry.frame,
        params: {
          elapsed: layer.localElapsed,
          duration: layer.clipDuration,
          fadeIn: layer.kind === 'base' ? (this.getClipFadeIn(layer)) : 0,
          fadeOut: layer.kind === 'base' ? (this.getClipFadeOut(layer)) : 0,
          opacity: layer.opacity,
          uvScale,
          uvOffset,
          ...layerWarpDrawParams(layer, destRect),
          key: layer.key,
          destRect,
          clear: isFirstLayer,
        },
      });
      isFirstLayer = false;
    }

    flushPendingLayers();

    // Close any frames not consumed (e.g. still-image layers not in plan).
    frameMap.forEach((e) => e.frame.close());

    if (isFirstLayer && !isCancelled?.()) {
      this.engine.clearToBlack();
    }

    if (!isCancelled?.() && (finishing || isColorManagementActive(colorManagement))) {
      const seed =
        frameIndex ?? grainFrameSeedFromTime(plan.globalTime);
      this.engine.applyFinishing(finishing ?? DEFAULT_FINISHING, {
        frameIndex: seed,
        colorManagement,
      });
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

  /**
   * Copy of the composed frame for the gpu-chores scopes. Borrowed from the
   * engine (never destroy it) and only valid in the same task as the render
   * that produced it — see `PreviewEngine.captureScopeTexture`.
   */
  captureScopeTexture(): GPUTexture | null {
    return this.engine.captureScopeTexture();
  }

  get scopeTextureSize(): { width: number; height: number } {
    return this.engine.scopeTextureSize;
  }

  resetFinishingTemporal(): void {
    this.engine.resetFinishingTemporal();
  }

  destroy(): void {
    this.engine.destroy();
  }
}
