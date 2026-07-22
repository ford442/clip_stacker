/**
 * Hybrid encoder - automatically selects the best available encoding path:
 *
 *   1. Canvas renderer (audio-reactive) - browser compositing + MediaRecorder +
 *      FFmpeg audio mux; unlocks audio-reactive effects and advanced compositing.
 *   2. WebCodecs + WebGPU/Canvas compositor - VideoDecoder frame delivery,
 *      hardware H.264/HEVC/AV1 encode, FFmpeg audio mux; near-realtime and
 *      WYSIWYG with the WebGPU preview (transitions, PiP, text overlays, LUT).
 *   3. FFmpeg.wasm - CPU fallback when WebCodecs/WebGPU are unavailable, plus
 *      audio extract/mux and the explicit "Force FFmpeg" override.
 *
 * The caller only needs to call `hybridMergeClips` and handle the returned Blob.
 */

import type { Clip, ClipGroup, ClipTransition, ExportSettings, TextOverlay, RenderPlan } from '../types';
import { DEFAULT_COLOR_GRADE, type ColorGradeSettings } from '../utils/lut';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { mergeClips, calculateRenderPlan, muxVideoWithAudio } from '../ffmpeg/ffmpegService';
import { encodeClipsWithCanvas } from './canvas-encoder';
import { encodeVideoWithWebCodecs, isWebCodecsAvailable } from './webcodecs';
import { canUseGpuVideoEncoder } from './renderEligibility';
import { clipsNeedResolutionNormalization, parseOutputResolution } from './resolution';
import { isWebGpuExportAvailable } from '../webgpu/exportCompositor';

export type EncoderPath = 'webcodecs' | 'ffmpeg' | 'canvas';

export interface HybridEncodeResult {
  blob: Blob;
  path: EncoderPath;
  renderPlan?: RenderPlan;
}

/**
 * Merge clips using the best available encoder.
 */
export async function hybridMergeClips(
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  forceFFmpeg = false,
  textOverlays: TextOverlay[] = [],
  useCanvas = false,
  audioReactive = true,
  forceReencode = false,
  renderPlan?: RenderPlan,
  clipGroups: ClipGroup[] = [],
  colorGrade: ColorGradeSettings = DEFAULT_COLOR_GRADE,
): Promise<HybridEncodeResult> {
  let canvasFailure: string | null = null;
  let gpuFailure: string | null = null;

  const effectiveRenderPlan = renderPlan || calculateRenderPlan(clips, transitions, textOverlays, settings);

  // -- Canvas renderer path --------------------------------------------------
  if (useCanvas && typeof MediaRecorder !== 'undefined') {
    try {
      onStatus('Canvas renderer path selected (audio-reactive compositing)...');
      onProgress?.({ stage: 'Canvas renderer selected', progress: 0, indeterminate: false });
      const blob = await encodeClipsWithCanvas(clips, settings, onStatus, audioReactive, onProgress);
      return { blob, path: 'canvas', renderPlan: effectiveRenderPlan };
    } catch (err) {
      canvasFailure = (err as Error).message;
      onStatus(`Canvas render failed (${canvasFailure}). Trying next encoder...`);
    }
  }

  // -- GPU WebCodecs path (video hardware encode + FFmpeg audio mux) --------
  const webGpuAvailable = await isWebGpuExportAvailable();
  const gpuEligible = canUseGpuVideoEncoder(clips, transitions, textOverlays, {
    forceFFmpeg,
    useCanvas,
    webGpuAvailable,
    colorGrade,
  });
  const needsVideoNormalize = clipsNeedResolutionNormalization(clips, settings) || forceReencode;
  const { width, height } = parseOutputResolution(settings.outputResolution);

  if (gpuEligible && (needsVideoNormalize || effectiveRenderPlan.willReencode)) {
    const gpuAvailable = await isWebCodecsAvailable(width, height);
    if (gpuAvailable) {
      try {
        onStatus('GPU path selected (hardware H.264 + FFmpeg audio mux)...');
        onProgress?.({ stage: 'GPU encoder selected', progress: 0, indeterminate: false });
        const videoBlob = await encodeVideoWithWebCodecs(
          clips,
          settings,
          onStatus,
          onProgress,
          'auto',
          transitions,
          textOverlays,
          clipGroups,
          colorGrade,
        );
        onStatus('Muxing GPU video with source audio via FFmpeg...');
        const blob = await muxVideoWithAudio(videoBlob, clips, settings, onStatus, onProgress);
        return { blob, path: 'webcodecs', renderPlan: effectiveRenderPlan };
      } catch (err) {
        gpuFailure = (err as Error).message;
        onStatus(`GPU encode failed (${gpuFailure}). Falling back to FFmpeg...`);
      }
    }
  }

  // -- FFmpeg path (default / fallback) -------------------------------------
  if (!forceFFmpeg && !useCanvas && !gpuEligible) {
    onStatus('FFmpeg path selected for audio-preserving export...');
  } else if (gpuFailure || canvasFailure) {
    onStatus('FFmpeg fallback path selected...');
  }
  onProgress?.({ stage: 'FFmpeg path selected', progress: 0, indeterminate: false });

  try {
    const blob = await mergeClips(clips, transitions, settings, onStatus, textOverlays, onProgress, forceReencode);
    return { blob, path: 'ffmpeg', renderPlan: effectiveRenderPlan };
  } catch (err) {
    const prev: string[] = [];
    if (canvasFailure) prev.push(`Canvas: ${canvasFailure}`);
    if (gpuFailure) prev.push(`GPU: ${gpuFailure}`);
    if (prev.length > 0) {
      const orig = (err as Error).message;
      const e = new Error(`${orig}\n\nPrevious encoder attempts that also failed:\n${prev.join('\n')}`);
      (e as any).ffmpegLogs = (err as any).ffmpegLogs;
      throw e;
    }
    throw err;
  }
}
