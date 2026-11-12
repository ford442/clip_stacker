/**
 * WebGPU timeline compositor export: one frame per output timestamp with
 * overlapping GPU submit of N+1 after capturing N.
 */

import { effectiveTextOverlays } from '../composition/nestedSequences';
import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { computeTotalDuration } from '../timeline/transitions';
import { canCaptureWebGpuCanvasWithText } from './renderEligibility';
import { DEFAULT_FINISHING, type FinishingSettings } from '../finishing/finishing';
import {
  ColorPipelineExportError,
  DEFAULT_COLOR_MANAGEMENT,
  exportCanvas2dSettings,
  type ColorManagementSettings,
} from '../finishing/colorManagement';
import {
  buildPreviewCompositionPlan,
  type CaptionPlanOptions,
} from '../composition/previewComposition';
import { renderTextOverlaysAsync } from './canvasRenderer';
import { TimelineDecoderFrameProvider } from '../media/decoderFrameProvider';
import { TimelinePreviewEngine } from '../webgpu/timelinePreview';
import { getTimelineClips } from '../timeline/timelineClips';
import {
  computeTimelineExportFrameCount,
  flushCaptureThenScheduleNext,
  globalTimeForTimelineFrame,
  shouldEmitTimelineStatusUpdate,
  MAX_ENCODE_QUEUE_DEPTH,
  timelineFrameTimestampUs,
  timelineStatusThrottleFrames,
  TIMELINE_EXPORT_FPS,
} from './webcodecsTimeline';
import { encodeAndClose, waitForQueueBelow } from './codecQueue';
import {
  buildVideoEncoderConfig,
  resolveEncoderBitrate,
  resolveEncoderCodec,
  webCodecsEncodeProgress,
  WEBCODECS_PROGRESS_STAGES,
} from './webcodecsCodec';
import { createExportMuxer, muxTimelineAudioIfRequested } from './webcodecsMux';

export async function encodeTimelineComposite(
  clips: Clip[],
  clipGroups: ClipGroup[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  settings: ExportSettings,
  width: number,
  height: number,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  finishing: FinishingSettings = DEFAULT_FINISHING,
  includeWebCodecsAudio = false,
  captionBurnIn: CaptionPlanOptions = {},
  colorManagement: ColorManagementSettings = DEFAULT_COLOR_MANAGEMENT,
): Promise<Blob> {
  onStatus(`WebGPU timeline export (${width}x${height})...`);
  onProgress?.({ stage: WEBCODECS_PROGRESS_STAGES.decodeCompositeEncode, progress: 0, indeterminate: false });

  const timelineClips = getTimelineClips(clips, clipGroups);
  const totalDuration = computeTotalDuration(timelineClips, transitions);
  const totalFrames = computeTimelineExportFrameCount(totalDuration, TIMELINE_EXPORT_FPS);
  // Titles inside nested sequences come out of the plan too.
  const drawnOverlays = effectiveTextOverlays(timelineClips, textOverlays);
  const hasTextOverlays = drawnOverlays.length > 0;
  const hasCaptions = (captionBurnIn.captions?.length ?? 0) > 0;
  const outputColor = colorManagement.outputColor;
  const hdr10 = outputColor === 'hdr10';
  // HDR10: titles and captions are drawn on a transparent 2D canvas and
  // composited in the working space at the graphics white, before the PQ
  // output transform (`ManagedFinishingChain`), so the 10-bit file has them.
  const hdrGraphics = hdr10 && (hasTextOverlays || hasCaptions);
  // Captions are rasterized on the 2D pass (no shader fill), so any cue forces
  // the 2D composite even when every text overlay could have stayed on the GPU.
  // Both still ride the same encode — this is what removes the burn-in
  // post-pass's extra full re-encode.
  const shaderTextOnGpu =
    !hdr10 && hasTextOverlays && !hasCaptions && canCaptureWebGpuCanvasWithText(drawnOverlays);
  const use2dTextComposite = !hdr10 && (hasTextOverlays || hasCaptions) && !shaderTextOnGpu;
  const statusThrottleFrames = timelineStatusThrottleFrames(TIMELINE_EXPORT_FPS);
  const frameDurationUs = Math.round(1_000_000 / TIMELINE_EXPORT_FPS);

  const videoCanvas = document.createElement('canvas');
  videoCanvas.width = width;
  videoCanvas.height = height;

  let exportCanvas: HTMLCanvasElement | null = null;
  let exportCtx: CanvasRenderingContext2D | null = null;
  if (use2dTextComposite) {
    exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    exportCtx = exportCanvas.getContext('2d', exportCanvas2dSettings(colorManagement.outputColor));
    if (!exportCtx) throw new Error('Could not create export canvas');
  }

  let graphicsCanvas: HTMLCanvasElement | null = null;
  if (hdrGraphics) {
    graphicsCanvas = document.createElement('canvas');
    graphicsCanvas.width = width;
    graphicsCanvas.height = height;
  }

  // Offscreen: an HDR10 timeline composites on a float canvas whatever the
  // monitor is, and the encoder reads the PQ image, not the canvas.
  const engine = await TimelinePreviewEngine.create(videoCanvas, clips, { surface: 'offscreen' });
  engine.resetFinishingTemporal();
  // Decoder cursors deliver frames by walking each layer's source time
  // forward — export never scrubs — so this replaces the <video> element
  // seek in the hot path. Layers whose codec/container it can't handle fall
  // back to the seek path automatically (see TimelineDecoderFrameProvider).
  const frameProvider = new TimelineDecoderFrameProvider();

  const bitrate = resolveEncoderBitrate(settings, width, height);
  const encoderCodec = await resolveEncoderCodec(
    settings.videoCodec,
    width,
    height,
    bitrate,
    outputColor,
  );
  const muxer = createExportMuxer(width, height, encoderCodec, includeWebCodecsAudio);

  let videoError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { videoError = e; },
  });

  videoEncoder.configure(
    buildVideoEncoderConfig(encoderCodec, width, height, bitrate, TIMELINE_EXPORT_FPS, outputColor),
  );

  const renderTimelineFrame = async (frameIndex: number) => {
    const globalTime = globalTimeForTimelineFrame(frameIndex, TIMELINE_EXPORT_FPS);
    const plan = buildPreviewCompositionPlan(
      clips,
      clipGroups,
      transitions,
      textOverlays,
      settings,
      globalTime,
      height,
      width,
      captionBurnIn,
    );
    if (graphicsCanvas) {
      await renderTextOverlaysAsync(graphicsCanvas, plan, { clear: true });
    }
    await engine.renderPlan(plan, {
      finishing,
      frameProvider,
      frameIndex,
      colorManagement,
      ...(graphicsCanvas ? { graphicsOverlay: graphicsCanvas } : {}),
    });
    return plan;
  };

  // HDR10 frames read back through the engine's three-slot ring: frame N
  // maps while N+1 and N+2 compose. Encoded strictly in order.
  const pendingHdr: Array<{ frame: Promise<VideoFrame>; frameIndex: number }> = [];
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
    encodeAndClose(videoEncoder, frame, { keyFrame: next.frameIndex % 60 === 0 });
  };

  let lastStatusFrame = -statusThrottleFrames;
  let pendingRender: Promise<Awaited<ReturnType<typeof renderTimelineFrame>>> | null =
    totalFrames > 0 ? renderTimelineFrame(0) : null;

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const globalTime = globalTimeForTimelineFrame(frameIndex, TIMELINE_EXPORT_FPS);

      if (
        shouldEmitTimelineStatusUpdate(
          frameIndex,
          lastStatusFrame,
          statusThrottleFrames,
          totalFrames,
        )
      ) {
        onStatus(`GPU timeline encode: ${globalTime.toFixed(1)}s / ${totalDuration.toFixed(1)}s`);
        lastStatusFrame = frameIndex;
      }
      onProgress?.(webCodecsEncodeProgress(globalTime, totalDuration));

      const plan = await pendingRender!;

      if (hdr10) {
        // No queue-wide flush: the capture is recorded behind this frame's
        // render in queue order, so N+1 can be scheduled right away.
        if (pendingHdr.length >= engine.hdr10ReadbackDepth) await encodeOldestHdr();
        const frame = engine.captureHdr10Frame({
          timestamp: timelineFrameTimestampUs(frameIndex, TIMELINE_EXPORT_FPS),
          duration: frameDurationUs,
        });
        // Awaited in order by encodeOldestHdr; this only keeps an early
        // rejection from being reported as unhandled in the meantime.
        void frame.catch(() => undefined);
        pendingHdr.push({ frame, frameIndex });
        pendingRender = frameIndex + 1 < totalFrames ? renderTimelineFrame(frameIndex + 1) : null;
      } else {
        await flushCaptureThenScheduleNext(
          async () => {
            // Wait for WebGPU submit to land before capturing pixels for encode.
            await engine.flush();

            let frameSource: CanvasImageSource;
            if (shaderTextOnGpu) {
              await engine.compositeShaderTextOverlays(plan);
              frameSource = videoCanvas;
            } else if (use2dTextComposite) {
              exportCtx!.drawImage(videoCanvas, 0, 0);
              await renderTextOverlaysAsync(exportCtx!.canvas, plan, {
                clear: false,
              });
              frameSource = exportCanvas!;
            } else {
              frameSource = videoCanvas;
            }

            if (outputColor === 'display-p3' && engine.canvasPresentation.presentFallback) {
              throw new ColorPipelineExportError(
                'Display P3 canvas is not available in this browser. Export was not tagged as Display P3.',
              );
            }
            const frame = new VideoFrame(frameSource, {
              timestamp: timelineFrameTimestampUs(frameIndex, TIMELINE_EXPORT_FPS),
              duration: frameDurationUs,
            });
            encodeAndClose(videoEncoder, frame, { keyFrame: frameIndex % 60 === 0 });
          },
          frameIndex + 1 < totalFrames
            ? () => {
                pendingRender = renderTimelineFrame(frameIndex + 1);
              }
            : null,
        );
      }

      if (videoError) throw videoError;
      muxer.throwIfFailed();
      await waitForQueueBelow(videoEncoder, MAX_ENCODE_QUEUE_DEPTH + 1).catch((err: unknown) => {
        throw videoError ?? err;
      });
    }

    while (pendingHdr.length > 0) {
      await encodeOldestHdr();
      if (videoError) throw videoError;
    }

    onStatus('Flushing GPU encoder...');
    onProgress?.({ stage: WEBCODECS_PROGRESS_STAGES.flush, progress: 0.9, indeterminate: false });
    await videoEncoder.flush();
    if (videoError) throw videoError;

    await muxTimelineAudioIfRequested(
      muxer,
      clips,
      clipGroups,
      transitions,
      includeWebCodecsAudio,
      onStatus,
      onProgress,
    );

    const buffer = await muxer.finalize();
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    // Frames still mapping when an error stopped the loop: close what arrives.
    for (const pending of pendingHdr.splice(0)) {
      void pending.frame.then((frame) => frame.close(), () => undefined);
    }
    frameProvider.destroy();
    engine.destroy();
  }
}
