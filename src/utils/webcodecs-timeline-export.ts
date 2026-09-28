/**
 * WebGPU timeline compositor export: one frame per output timestamp with
 * overlapping GPU submit of N+1 after capturing N.
 */

import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import { ArrayBufferTarget } from 'mp4-muxer';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { computeTotalDuration } from './transitions';
import { canCaptureWebGpuCanvasWithText } from './renderEligibility';
import { DEFAULT_FINISHING, type FinishingSettings } from './finishing';
import {
  ColorPipelineExportError,
  DEFAULT_COLOR_MANAGEMENT,
  HDR10_COLOR_SPACE,
  type ColorManagementSettings,
} from './colorManagement';
import {
  buildPreviewCompositionPlan,
  type CaptionPlanOptions,
} from './previewComposition';
import { renderTextOverlaysAsync } from './canvas-renderer';
import { TimelineDecoderFrameProvider } from './decoderFrameProvider';
import { TimelinePreviewEngine } from '../webgpu/timelinePreview';
import { getTimelineClips } from './timelineClips';
import {
  computeTimelineExportFrameCount,
  flushCaptureThenScheduleNext,
  globalTimeForTimelineFrame,
  shouldEmitTimelineStatusUpdate,
  shouldWaitForEncoderBackpressure,
  timelineFrameTimestampUs,
  timelineStatusThrottleFrames,
  TIMELINE_EXPORT_FPS,
} from './webcodecs-timeline';
import {
  buildVideoEncoderConfig,
  mapWebCodecsProgress,
  resolveEncoderBitrate,
  resolveEncoderCodec,
  waitForEncoderDequeue,
  WEBCODECS_PROGRESS_STAGES,
} from './webcodecs-codec';
import { createExportMuxer, muxTimelineAudioIfRequested } from './webcodecs-mux';

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
  const hasTextOverlays = textOverlays.length > 0;
  const hasCaptions = (captionBurnIn.captions?.length ?? 0) > 0;
  // Captions are rasterized on the 2D pass (no shader fill), so any cue forces
  // the 2D composite even when every text overlay could have stayed on the GPU.
  // Both still ride the same encode — this is what removes the burn-in
  // post-pass's extra full re-encode.
  const shaderTextOnGpu =
    hasTextOverlays && !hasCaptions && canCaptureWebGpuCanvasWithText(textOverlays);
  const use2dTextComposite = (hasTextOverlays || hasCaptions) && !shaderTextOnGpu;
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
    exportCtx = exportCanvas.getContext('2d');
    if (!exportCtx) throw new Error('Could not create export canvas');
  }

  const engine = await TimelinePreviewEngine.create(videoCanvas, clips);
  engine.resetFinishingTemporal();
  // Decoder cursors deliver frames by walking each layer's source time
  // forward — export never scrubs — so this replaces the <video> element
  // seek in the hot path. Layers whose codec/container it can't handle fall
  // back to the seek path automatically (see TimelineDecoderFrameProvider).
  const frameProvider = new TimelineDecoderFrameProvider();

  const bitrate = resolveEncoderBitrate(settings, width, height);
  const outputColor = colorManagement.outputColor;
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
    await engine.renderPlan(plan, { finishing, frameProvider, frameIndex, colorManagement });
    return plan;
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
      onProgress?.({
        stage: WEBCODECS_PROGRESS_STAGES.decodeCompositeEncode,
        progress: mapWebCodecsProgress(globalTime, totalDuration),
        indeterminate: totalDuration <= 0,
      });

      const plan = await pendingRender!;

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

          const timestamp = timelineFrameTimestampUs(frameIndex, TIMELINE_EXPORT_FPS);
          let frame: VideoFrame;
          if (outputColor === 'hdr10') {
            const rgba = await engine.readPqExportRgba();
            if (!rgba) {
              throw new ColorPipelineExportError(
                'HDR10 frame readback produced no image. This file was not tagged Rec.709.',
              );
            }
            try {
              frame = new VideoFrame(rgba, {
                format: 'RGBA',
                codedWidth: width,
                codedHeight: height,
                timestamp,
                duration: frameDurationUs,
                colorSpace: HDR10_COLOR_SPACE as VideoColorSpaceInit,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : 'VideoFrame rejected the PQ buffer';
              throw new ColorPipelineExportError(`${message} This file was not tagged Rec.709.`);
            }
          } else if (outputColor === 'display-p3' && engine.canvasPresentation.presentFallback) {
            throw new ColorPipelineExportError(
              'Display P3 canvas is not available in this browser. Export was not tagged as Display P3.',
            );
          } else {
            frame = new VideoFrame(frameSource, {
              timestamp,
              duration: frameDurationUs,
            });
          }
          videoEncoder.encode(frame, { keyFrame: frameIndex % 60 === 0 });
          frame.close();
        },
        frameIndex + 1 < totalFrames
          ? () => {
              pendingRender = renderTimelineFrame(frameIndex + 1);
            }
          : null,
      );

      if (shouldWaitForEncoderBackpressure(videoEncoder.encodeQueueSize)) {
        await waitForEncoderDequeue(videoEncoder);
      }
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

    muxer.finalize();
    const { buffer } = muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    frameProvider.destroy();
    engine.destroy();
  }
}
