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

import type { CaptionEntry, Clip, ClipGroup, ClipTransition, ExportSettings, MasterAudio, TextOverlay, TextOverlayStyle, RenderPlan } from '../types';
import { DEFAULT_FINISHING, type FinishingSettings } from '../utils/finishing';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { mergeClips, calculateRenderPlan, muxVideoWithAudio } from '../ffmpeg/ffmpegService';
import { encodeClipsWithCanvas } from './canvas-encoder';
import { encodeVideoWithWebCodecs, isWebCodecsAvailable } from './webcodecs';
import {
  assessWebCodecsAudioMix,
  isAudioEncoderAvailable,
  prepareStreamingAudioMix,
} from './webcodecs-audio';
import { canUseGpuVideoEncoder } from './renderEligibility';
import { clipsNeedResolutionNormalization, parseOutputResolution } from './resolution';
import { isWebGpuExportAvailable } from '../webgpu/exportCompositor';
import { resolveLayerKey } from './overlayKey';

export type EncoderPath = 'webcodecs-av' | 'webcodecs' | 'ffmpeg' | 'canvas';

export interface HybridEncodeResult {
  blob: Blob;
  path: EncoderPath;
  renderPlan?: RenderPlan;
  /**
   * True when the encoder drew the caption cues into the composite itself, so
   * the caller must skip the FFmpeg burn-in post-pass (it would burn a second
   * copy on top and cost a full re-encode).
   */
  captionsBurnedIn?: boolean;
}

/** Caption cues to burn into the composite, when the export mode is burn-in. */
export interface CaptionBurnInRequest {
  captions: CaptionEntry[];
  captionStyle?: Partial<TextOverlayStyle>;
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
  finishing: FinishingSettings = DEFAULT_FINISHING,
  masterAudio: MasterAudio | null = null,
  captionBurnIn: CaptionBurnInRequest | null = null,
): Promise<HybridEncodeResult> {
  let canvasFailure: string | null = null;
  let gpuFailure: string | null = null;

  const effectiveRenderPlan = renderPlan || calculateRenderPlan(clips, transitions, textOverlays, settings);

  // Chroma/luma keying now lives in the compositors (WGSL + Canvas2D), so the
  // GPU path keys the same way the preview does and never also runs FFmpeg's
  // `chromakey` — only the FFmpeg filter-graph path does. Recorded on the
  // resolved plan so the toolbar can say which one ran.
  const hasKeyedClip = clips.some((clip) => resolveLayerKey(clip) !== null);
  const planWithKeying = (
    where: NonNullable<RenderPlan['overlayKeying']>,
  ): RenderPlan =>
    hasKeyedClip
      ? { ...effectiveRenderPlan, overlayKeying: where }
      : effectiveRenderPlan;

  // -- Canvas renderer path --------------------------------------------------
  if (useCanvas && typeof MediaRecorder !== 'undefined') {
    try {
      onStatus('Canvas renderer path selected (audio-reactive compositing)...');
      onProgress?.({ stage: 'Canvas renderer selected', progress: 0, indeterminate: false });
      const blob = await encodeClipsWithCanvas(clips, settings, onStatus, audioReactive, onProgress);
      return {
        blob,
        path: 'canvas',
        renderPlan: planWithKeying('unsupported'),
      };
    } catch (err) {
      canvasFailure = (err as Error).message;
      onStatus(`Canvas render failed (${canvasFailure}). Trying next encoder...`);
    }
  }

  // -- GPU WebCodecs path (hardware video + WebCodecs AAC or FFmpeg audio mux) -
  const webGpuAvailable = await isWebGpuExportAvailable();
  const gpuEligible = canUseGpuVideoEncoder(clips, transitions, textOverlays, {
    forceFFmpeg,
    useCanvas,
    webGpuAvailable,
    finishing,
  });
  const needsVideoNormalize = clipsNeedResolutionNormalization(clips, settings) || forceReencode;
  const { width, height } = parseOutputResolution(settings.outputResolution);

  if (gpuEligible && (needsVideoNormalize || effectiveRenderPlan.willReencode)) {
    const gpuAvailable = await isWebCodecsAvailable(width, height);
    if (gpuAvailable) {
      const audioEncoderOk = await isAudioEncoderAvailable();
      // Media-engine streaming mix has no length cap; without it (load failure
      // or ?no_media_engine) long timelines fall back to FFmpeg audio mux.
      const streamingMix = audioEncoderOk && (await prepareStreamingAudioMix());
      const audioMix = assessWebCodecsAudioMix(clips, clipGroups, transitions, { streamingMix });
      const useWebCodecsAudio = audioEncoderOk && audioMix.supported;

      try {
        if (useWebCodecsAudio) {
          onStatus('GPU path selected (hardware video + WebCodecs AAC, no FFmpeg)...');
        } else if (audioEncoderOk && !audioMix.supported) {
          onStatus(`WebCodecs audio unavailable (${audioMix.reason}); using FFmpeg audio mux...`);
        } else {
          onStatus('GPU path selected (hardware video + FFmpeg audio mux)...');
        }
        onProgress?.({ stage: 'GPU encoder selected', progress: 0, indeterminate: false });

        const burnCaptions =
          captionBurnIn && captionBurnIn.captions.length > 0
            ? captionBurnIn
            : null;

        const blob = await encodeVideoWithWebCodecs(
          clips,
          settings,
          onStatus,
          onProgress,
          'auto',
          transitions,
          textOverlays,
          clipGroups,
          finishing,
          useWebCodecsAudio,
          burnCaptions ?? {},
        );
        const captionsBurnedIn = Boolean(burnCaptions);

        if (useWebCodecsAudio) {
          return {
            blob,
            path: 'webcodecs-av',
            renderPlan: planWithKeying('gpu'),
            captionsBurnedIn,
          };
        }

        onStatus('Muxing GPU video with source audio via FFmpeg...');
        const muxed = await muxVideoWithAudio(
          blob,
          clips,
          settings,
          onStatus,
          onProgress,
          clipGroups,
          transitions,
        );
        return {
          blob: muxed,
          path: 'webcodecs',
          renderPlan: planWithKeying('gpu'),
          captionsBurnedIn,
        };
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

  const shaderOverlays = textOverlays.filter((o) => o.fill === 'shader');
  if (shaderOverlays.length > 0) {
    const names = shaderOverlays.map((o) => `"${o.text}"`).join(', ');
    onStatus(
      `⚠ FFmpeg export doesn't support shader-filled text — ${names} will render as solid color. ` +
        `Switch Fill to Solid on ${shaderOverlays.length > 1 ? 'these overlays' : 'this overlay'} to guarantee the look, ` +
        `or use the GPU render path (avoid Force FFmpeg / Canvas renderer) to preserve the shader.`,
    );
  }

  try {
    const blob = await mergeClips(
      clips,
      transitions,
      settings,
      onStatus,
      textOverlays,
      onProgress,
      forceReencode,
      finishing,
      masterAudio,
    );
    const keyedPlan = planWithKeying('ffmpeg');
    const ffmpegRenderPlan: RenderPlan =
      shaderOverlays.length > 0
        ? {
            ...keyedPlan,
            shaderTextOverlays: shaderOverlays.map((o) => ({ id: o.id, text: o.text })),
            shaderTextFallbackApplied: true,
          }
        : keyedPlan;
    return { blob, path: 'ffmpeg', renderPlan: ffmpegRenderPlan };
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
