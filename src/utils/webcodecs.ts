/**
 * WebCodecs-based encoder for GPU-accelerated video export.
 *
 * Architecture (Holy Grail path):
 *  - Decode: VideoDecoder (mp4box demux + ring buffer; see webcodecs-decoder.ts)
 *  - Composite: WebGPU exportCompositor / timelinePreview (VideoFrame → shaders)
 *  - Encode: VideoEncoder (hardware H.264/HEVC/AV1) ← canvas after GPU flush
 *  - Mux: mp4-muxer (video + optional WebCodecs AAC); FFmpeg only for audio mux
 *    fallback via muxVideoWithAudio when AudioEncoder path is unavailable
 *  - Decode fallback: HTMLVideoElement → requestVideoFrameCallback when a clip
 *    cannot be demuxed/decoded with WebCodecs
 *
 * When transitions are active and WebGPU is available, the timeline compositor
 * renders identical WGSL transition frames as preview (WYSIWYG export).
 *
 * Falls back gracefully; callers should wrap in try/catch and fall back to FFmpeg.
 *
 * Implementation is split by responsibility:
 *  - webcodecs-codec.ts — codec probe, bitrate, progress stages
 *  - webcodecs-mux.ts — mp4-muxer session + optional AAC mix-in
 *  - webcodecs-compositor.ts — canvas/WebGPU draw + overlay pass
 *  - webcodecs-clip-encode.ts — sequential per-clip encode
 *  - webcodecs-timeline-export.ts — timeline compositor encode
 */

import { ArrayBufferTarget } from 'mp4-muxer';
import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { getClipDuration } from './project';
import { parseOutputResolution } from './resolution';
import {
  needsOverlayPass,
  shouldUseTimelineGpuExport,
} from './renderEligibility';
import { DEFAULT_FINISHING, type FinishingSettings } from './finishing';
import { isWebGpuExportAvailable } from '../webgpu/exportCompositor';
import {
  TARGET_FPS,
  buildVideoEncoderConfig,
  mapWebCodecsProgress,
  resolveEncoderBitrate,
  resolveEncoderCodec,
  WEBCODECS_PROGRESS_STAGES,
} from './webcodecs-codec';
import { createExportMuxer, muxTimelineAudioIfRequested } from './webcodecs-mux';
import {
  DecoderTextOverlayPass,
  resolveCompositor,
  type GpuCompositorKind,
} from './webcodecs-compositor';
import { encodeVideoFrames } from './webcodecs-clip-encode';
import { encodeTimelineComposite } from './webcodecs-timeline-export';

export type { GpuCompositorKind } from './webcodecs-compositor';
export type { ExportVideoCodec, ResolvedEncoderCodec, VideoEncoderConfigWithColorSpace } from './webcodecs-codec';
export {
  EXPORT_BITRATE_MODE,
  REC709_COLOR_SPACE,
  VIDEO_ENCODER_LATENCY_MODE,
  WEBCODECS_PROGRESS_STAGES,
  buildVideoEncoderConfig,
  codecCandidates,
  crfToBitsPerPixel,
  getLastResolvedEncoderCodec,
  h264CodecString,
  isWebCodecsAvailable,
  resolveEncoderBitrate,
  resolveEncoderCodec,
} from './webcodecs-codec';

/**
 * Encode timeline video with hardware H.264. When `includeWebCodecsAudio` is
 * true, timeline audio is mixed and encoded with `AudioEncoder` into the same
 * mp4-muxer session (no FFmpeg on the happy path).
 */
export async function encodeVideoWithWebCodecs(
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  compositorPreference: GpuCompositorKind = 'auto',
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  clipGroups: ClipGroup[] = [],
  finishing: FinishingSettings = DEFAULT_FINISHING,
  includeWebCodecsAudio = false,
): Promise<Blob> {
  const { width, height } = parseOutputResolution(settings.outputResolution);

  if (shouldUseTimelineGpuExport(clips, transitions, textOverlays, finishing)) {
    const webGpuOk = await isWebGpuExportAvailable();
    if (!webGpuOk) {
      throw new Error('WebGPU required for GPU timeline compositor export');
    }
    return encodeTimelineComposite(
      clips,
      clipGroups,
      transitions,
      textOverlays,
      settings,
      width,
      height,
      onStatus,
      onProgress,
      finishing,
      includeWebCodecsAudio,
    );
  }

  onStatus(
    compositorPreference === 'webgpu'
      ? 'Initializing WebGPU + hardware encoder...'
      : 'Initializing GPU hardware encoder...',
  );
  onProgress?.({ stage: WEBCODECS_PROGRESS_STAGES.init, progress: 0, indeterminate: false });

  const compositor = await resolveCompositor(width, height, compositorPreference);
  onStatus(
    compositor.kind === 'webgpu'
      ? `WebGPU compositor active (${width}x${height})`
      : `Canvas compositor active (${width}x${height})`,
  );

  const bitrate = resolveEncoderBitrate(settings, width, height);
  const encoderCodec = await resolveEncoderCodec(settings.videoCodec, width, height, bitrate);
  const muxer = createExportMuxer(width, height, encoderCodec, includeWebCodecsAudio);

  let videoError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { videoError = e; },
  });

  videoEncoder.configure(buildVideoEncoderConfig(encoderCodec, width, height, bitrate, TARGET_FPS));

  let videoTimeUs = 0;
  const totalDuration = clips.reduce((sum, clip) => sum + getClipDuration(clip), 0);
  let elapsedDuration = 0;
  const overlayPass = needsOverlayPass(textOverlays, finishing)
    ? new DecoderTextOverlayPass(
        clips,
        clipGroups,
        transitions,
        textOverlays,
        settings,
        width,
        height,
      )
    : null;

  try {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      onStatus(`GPU encode [${i + 1}/${clips.length}]: "${clip.title}"...`);
      onProgress?.({
        stage: WEBCODECS_PROGRESS_STAGES.decodeCompositeEncode,
        progress: mapWebCodecsProgress(elapsedDuration, totalDuration),
        indeterminate: totalDuration <= 0,
      });

      videoTimeUs = await encodeVideoFrames(
        videoEncoder,
        compositor,
        clip,
        videoTimeUs,
        width,
        height,
        finishing,
        elapsedDuration,
        overlayPass,
      );
      if (videoError) throw videoError;

      elapsedDuration += getClipDuration(clip);
      onProgress?.({
        stage: WEBCODECS_PROGRESS_STAGES.decodeCompositeEncode,
        progress: mapWebCodecsProgress(elapsedDuration, totalDuration),
        indeterminate: totalDuration <= 0,
      });
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
    onProgress?.({ stage: WEBCODECS_PROGRESS_STAGES.finalize, progress: 0.92, indeterminate: false });

    const { buffer } = muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    compositor.gpuCompositor?.destroy();
  }
}

/** @deprecated Use encodeVideoWithWebCodecs + muxVideoWithAudio instead. */
export async function encodeClipsWithWebCodecs(
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  transitions: ClipTransition[] = [],
): Promise<Blob> {
  return encodeVideoWithWebCodecs(clips, settings, onStatus, onProgress, 'auto', transitions);
}
