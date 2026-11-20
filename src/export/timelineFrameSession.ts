/**
 * The GPU timeline compositor as an export frame source: renders output
 * frames from their composition plans and hands the encoder one `VideoFrame`
 * per frame, overlapping the GPU work of frame N+1 with the encode of N
 * (SDR) or reading HDR10 frames back through the engine's three-slot ring.
 *
 * `encodeRange` is the loop both export shapes run: the continuous export
 * (one encoder, all frames) and the segmented one (a fresh encoder per
 * segment, `renderCache/segmentedExport.ts`).
 */

import { ColorPipelineExportError, exportCanvas2dSettings, type ColorManagementSettings } from '../finishing/colorManagement';
import type { FinishingSettings } from '../finishing/finishing';
import type { PreviewCompositionPlan } from '../composition/previewCompositionTypes';
import { renderTextOverlaysAsync } from './canvasRenderer';
import { TimelineDecoderFrameProvider } from '../media/decoderFrameProvider';
import { TimelinePreviewEngine } from '../webgpu/timelinePreview';
import {
  flushCaptureThenScheduleNext,
  MAX_ENCODE_QUEUE_DEPTH,
  timelineFrameTimestampUs,
} from './webcodecsTimeline';
import { encodeAndClose, waitForQueueBelow } from './codecQueue';

/** Below this peak (8-bit scale) a frame counts as black. */
const BLACK_FRAME_PEAK = 10;

/**
 * Peak picture level of a frame on an 8-bit scale (0 = black … 255), from a
 * copy of its first plane: the max R/G/B of an RGB frame, or the Y plane
 * mapped from limited range (8-bit 16–235, 10-bit 64–940). Null for a pixel
 * format it does not read. `format` is a string because the DOM typings'
 * `VideoPixelFormat` lacks the 10-bit formats (`I420P10`, …).
 */
export function framePeakLevel(
  format: string | null,
  data: Uint8Array,
  plane: PlaneLayout,
  width: number,
  height: number,
): number | null {
  let peak = 0;
  switch (format) {
    case 'RGBA':
    case 'RGBX':
    case 'BGRA':
    case 'BGRX':
      for (let y = 0; y < height; y++) {
        const row = plane.offset + y * plane.stride;
        for (let x = 0; x < width; x++) {
          const at = row + x * 4;
          peak = Math.max(peak, data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0);
        }
      }
      return peak;
    case 'I420':
    case 'I420A':
    case 'I422':
    case 'I444':
    case 'NV12':
      for (let y = 0; y < height; y++) {
        const row = plane.offset + y * plane.stride;
        for (let x = 0; x < width; x++) peak = Math.max(peak, data[row + x] ?? 0);
      }
      return Math.max(0, ((peak - 16) * 255) / 219);
    case 'I420P10':
    case 'I420AP10':
    case 'I422P10':
    case 'I444P10': {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let y = 0; y < height; y++) {
        const row = plane.offset + y * plane.stride;
        for (let x = 0; x < width; x++) peak = Math.max(peak, view.getUint16(row + x * 2, true));
      }
      return Math.max(0, ((peak - 64) * 255) / 876);
    }
    default:
      return null;
  }
}

/** Whether frame 0 of `plan` should show a picture: a clip layer at least half visible. */
export function planExpectsPicture(plan: PreviewCompositionPlan): boolean {
  return plan.layers.some((layer) => (layer.kind === 'base' || layer.kind === 'pip') && layer.opacity >= 0.5);
}

/**
 * `?test_harness` only: fail the export when its first frame is black
 * although the plan draws a visible clip — the managed-colour (Display P3 /
 * HDR10) "frame 0 is black" regression (#373). One copy of frame 0, never
 * on a normal load.
 */
async function assertFirstFrameNotBlack(frame: VideoFrame, plan: PreviewCompositionPlan): Promise<void> {
  if (!planExpectsPicture(plan)) return;
  const data = new Uint8Array(frame.allocationSize());
  const layout = await frame.copyTo(data);
  const plane = layout[0];
  if (!plane) return;
  const width = frame.visibleRect?.width ?? frame.codedWidth;
  const height = frame.visibleRect?.height ?? frame.codedHeight;
  const peak = framePeakLevel(frame.format, data, plane, width, height);
  if (peak !== null && peak < BLACK_FRAME_PEAK) {
    throw new Error(
      `test harness: frame 0 of the export is black (${frame.format}, peak level ${peak.toFixed(1)}) ` +
        'although the plan draws a visible clip — the first managed-colour frame regression.',
    );
  }
}

export interface TimelineFrameSessionOptions {
  width: number;
  height: number;
  fps: number;
  finishing: FinishingSettings;
  colorManagement: ColorManagementSettings;
  /** HDR10: titles / captions composited in the working space before the PQ transform. */
  hdrGraphics: boolean;
  /** Shader-filled titles blitted on the GPU (no 2D composite). */
  shaderTextOnGpu: boolean;
  /** Titles / captions drawn on a 2D canvas over the composed frame. */
  use2dTextComposite: boolean;
  /** `?test_harness`: refuse a black frame 0. */
  checkFirstFrame: boolean;
  /** The plan of an output frame. */
  planFor(frameIndex: number): PreviewCompositionPlan;
}

/** One encoder target for `encodeRange`. */
export interface FrameEncoderTarget {
  encoder: VideoEncoder;
  /** The encoder's (or its muxer's) first failure, checked after every frame. */
  failure(): Error | null;
}

export class TimelineFrameSession {
  private readonly frameProvider = new TimelineDecoderFrameProvider();
  private readonly frameDurationUs: number;

  private constructor(
    private readonly engine: TimelinePreviewEngine,
    private readonly videoCanvas: HTMLCanvasElement,
    private readonly exportCtx: CanvasRenderingContext2D | null,
    private readonly graphicsCanvas: HTMLCanvasElement | null,
    private readonly options: TimelineFrameSessionOptions,
  ) {
    this.frameDurationUs = Math.round(1_000_000 / options.fps);
  }

  static async create(
    clips: Parameters<typeof TimelinePreviewEngine.create>[1],
    options: TimelineFrameSessionOptions,
  ): Promise<TimelineFrameSession> {
    const { width, height } = options;
    const videoCanvas = document.createElement('canvas');
    videoCanvas.width = width;
    videoCanvas.height = height;

    let exportCtx: CanvasRenderingContext2D | null = null;
    if (options.use2dTextComposite) {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = width;
      exportCanvas.height = height;
      exportCtx = exportCanvas.getContext('2d', exportCanvas2dSettings(options.colorManagement.outputColor));
      if (!exportCtx) throw new Error('Could not create export canvas');
    }

    let graphicsCanvas: HTMLCanvasElement | null = null;
    if (options.hdrGraphics) {
      graphicsCanvas = document.createElement('canvas');
      graphicsCanvas.width = width;
      graphicsCanvas.height = height;
    }

    // Offscreen: an HDR10 timeline composites on a float canvas whatever the
    // monitor is, and the encoder reads the PQ image, not the canvas.
    const engine = await TimelinePreviewEngine.create(videoCanvas, clips, { surface: 'offscreen' });
    engine.resetFinishingTemporal();
    return new TimelineFrameSession(engine, videoCanvas, exportCtx, graphicsCanvas, options);
  }

  /** Clear temporal noise-reduction history (a segment starts as if after a seek). */
  resetTemporal(): void {
    this.engine.resetFinishingTemporal();
  }

  private async renderFrame(frameIndex: number): Promise<PreviewCompositionPlan> {
    const plan = this.options.planFor(frameIndex);
    if (this.graphicsCanvas) {
      await renderTextOverlaysAsync(this.graphicsCanvas, plan, { clear: true });
    }
    // Decoder cursors deliver frames by walking each layer's source time
    // forward — export never scrubs — so this replaces the <video> element
    // seek in the hot path. Layers whose codec/container it can't handle fall
    // back to the seek path automatically (see TimelineDecoderFrameProvider).
    await this.engine.renderPlan(plan, {
      finishing: this.options.finishing,
      frameProvider: this.frameProvider,
      frameIndex,
      colorManagement: this.options.colorManagement,
      ...(this.graphicsCanvas ? { graphicsOverlay: this.graphicsCanvas } : {}),
    });
    return plan;
  }

  /**
   * Render and encode output frames [start, end) into `target`. A key frame
   * is requested at `start` and every `keyFrameInterval` frames after it.
   */
  async encodeRange(
    target: FrameEncoderTarget,
    start: number,
    end: number,
    keyFrameInterval: number,
    onFrame?: (frameIndex: number) => void,
  ): Promise<void> {
    if (end <= start) return;
    const { engine, options } = this;
    const hdr10 = options.colorManagement.outputColor === 'hdr10';
    const { encoder } = target;
    const keyFrame = (frameIndex: number) => (frameIndex - start) % keyFrameInterval === 0;

    // HDR10 frames read back through the engine's three-slot ring: frame N
    // maps while N+1 and N+2 compose. Encoded strictly in order.
    const pendingHdr: Array<{ frame: Promise<VideoFrame>; frameIndex: number; plan: PreviewCompositionPlan }> = [];
    const encodeOldestHdr = async () => {
      const next = pendingHdr.shift();
      if (!next) return;
      let frame: VideoFrame;
      try {
        frame = await next.frame;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'the 10-bit frame readback failed';
        throw new ColorPipelineExportError(
          `HDR10 frame readback failed (${message}). This browser may not build I420P10 video frames; ` +
            'the file was not written.',
        );
      }
      if (options.checkFirstFrame && next.frameIndex === 0) {
        try {
          await assertFirstFrameNotBlack(frame, next.plan);
        } catch (err) {
          frame.close();
          throw err;
        }
      }
      encodeAndClose(encoder, frame, { keyFrame: keyFrame(next.frameIndex) });
    };

    let pendingRender: Promise<PreviewCompositionPlan> | null = this.renderFrame(start);
    try {
      for (let frameIndex = start; frameIndex < end; frameIndex++) {
        const plan = await pendingRender!;
        const timestamp = timelineFrameTimestampUs(frameIndex, options.fps);

        if (hdr10) {
          // No queue-wide flush: the capture is recorded behind this frame's
          // render in queue order, so N+1 can be scheduled right away.
          if (pendingHdr.length >= engine.hdr10ReadbackDepth) await encodeOldestHdr();
          const frame = engine.captureHdr10Frame({ timestamp, duration: this.frameDurationUs });
          // Awaited in order by encodeOldestHdr; this only keeps an early
          // rejection from being reported as unhandled in the meantime.
          void frame.catch(() => undefined);
          pendingHdr.push({ frame, frameIndex, plan });
          pendingRender = frameIndex + 1 < end ? this.renderFrame(frameIndex + 1) : null;
        } else {
          await flushCaptureThenScheduleNext(
            async () => {
              // Wait for WebGPU submit to land before capturing pixels for encode.
              await engine.flush();
              const frame = new VideoFrame(await this.captureSource(plan), {
                timestamp,
                duration: this.frameDurationUs,
              });
              if (options.checkFirstFrame && frameIndex === 0) {
                try {
                  await assertFirstFrameNotBlack(frame, plan);
                } catch (err) {
                  frame.close();
                  throw err;
                }
              }
              encodeAndClose(encoder, frame, { keyFrame: keyFrame(frameIndex) });
            },
            frameIndex + 1 < end
              ? () => {
                  pendingRender = this.renderFrame(frameIndex + 1);
                }
              : null,
          );
        }

        const failed = target.failure();
        if (failed) throw failed;
        await waitForQueueBelow(encoder, MAX_ENCODE_QUEUE_DEPTH + 1).catch((err: unknown) => {
          throw target.failure() ?? err;
        });
        onFrame?.(frameIndex);
      }

      while (pendingHdr.length > 0) {
        await encodeOldestHdr();
        const failed = target.failure();
        if (failed) throw failed;
      }
    } finally {
      // Frames still mapping when an error stopped the loop: close what arrives.
      for (const pending of pendingHdr.splice(0)) {
        void pending.frame.then((frame) => frame.close(), () => undefined);
      }
      // A render scheduled past an error: let it settle unobserved.
      void pendingRender?.catch(() => undefined);
    }
  }

  /** The SDR frame to encode: the canvas, plus titles / captions where they are drawn on top. */
  private async captureSource(plan: PreviewCompositionPlan): Promise<CanvasImageSource> {
    const { options, engine, videoCanvas, exportCtx } = this;
    let source: CanvasImageSource = videoCanvas;
    if (options.shaderTextOnGpu) {
      await engine.compositeShaderTextOverlays(plan);
    } else if (options.use2dTextComposite && exportCtx) {
      exportCtx.drawImage(videoCanvas, 0, 0);
      await renderTextOverlaysAsync(exportCtx.canvas, plan, { clear: false });
      source = exportCtx.canvas;
    }
    if (options.colorManagement.outputColor === 'display-p3' && engine.canvasPresentation.presentFallback) {
      throw new ColorPipelineExportError(
        'Display P3 canvas is not available in this browser. Export was not tagged as Display P3.',
      );
    }
    return source;
  }

  destroy(): void {
    this.frameProvider.destroy();
    this.engine.destroy();
  }
}

/** Settings a frame session's text route depends on (for the cache key). */
export function frameSessionRoute(options: Pick<TimelineFrameSessionOptions, 'hdrGraphics' | 'shaderTextOnGpu' | 'use2dTextComposite'>): string {
  return [options.hdrGraphics, options.shaderTextOnGpu, options.use2dTextComposite].map(Number).join('');
}

