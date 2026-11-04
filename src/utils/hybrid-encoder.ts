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
import {
  exportAudioBus,
  exportBusActive,
  getLastExportAudioReport,
  resetExportAudioReport,
} from './exportAudioBus';
import { DEFAULT_FINISHING, type FinishingSettings } from '../utils/finishing';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { mergeClips, calculateRenderPlan, muxVideoWithAudio } from '../ffmpeg/ffmpegService';
import { encodeClipsWithCanvas } from './canvas-encoder';
import { encodeVideoWithWebCodecs, isWebCodecsAvailable } from './webcodecs';
import { getLastResolvedEncoderCodec } from './webcodecs-codec';
import {
  assessWebCodecsAudioMix,
  isAudioEncoderAvailable,
  prepareStreamingAudioMix,
} from './webcodecs-audio';
import { pictureTransformPlanFields } from './renderEligibility';
import {
  isGpuEncodeCandidate,
  selectEncoderPath,
  type EncoderPathInput,
} from './encoderPath';
import { clipsNeedResolutionNormalization, parseOutputResolution } from './resolution';
import { isWebGpuExportAvailable } from '../webgpu/exportCompositor';
import { resolveLayerKey } from './overlayKey';
import {
  ColorPipelineExportError,
  DEFAULT_COLOR_MANAGEMENT,
  isColorManagementActive,
  isColorPipelineExportError,
  stampWideColor,
  type ColorManagementSettings,
} from './colorManagement';

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
  colorManagement: ColorManagementSettings = DEFAULT_COLOR_MANAGEMENT,
): Promise<HybridEncodeResult> {
  let canvasFailure: string | null = null;
  let gpuFailure: string | null = null;
  // The audio premix reports what its bus graph did; start each render clean.
  resetExportAudioReport();
  const busActive = exportBusActive(exportAudioBus());

  // Probed once, up front, so both the render-plan estimate and the GPU
  // eligibility check below agree on whether WebGPU is actually there.
  const webGpuAvailable = await isWebGpuExportAvailable();

  const effectiveRenderPlan =
    renderPlan ||
    calculateRenderPlan(clips, transitions, textOverlays, settings, {
      finishing,
      forceFFmpeg,
      useCanvasRenderer: useCanvas,
      webGpuAvailable,
      forceReencode,
      outputColor: colorManagement.outputColor,
      captionMode: captionBurnIn && captionBurnIn.captions.length > 0 ? 'burn' : undefined,
    });

  // Chroma/luma keying now lives in the compositors (WGSL + Canvas2D), so the
  // GPU path keys the same way the preview does and never also runs FFmpeg's
  // `chromakey` — only the FFmpeg filter-graph path does. Recorded on the
  // resolved plan so the toolbar can say which one ran.
  const hasKeyedClip = clips.some((clip) => resolveLayerKey(clip) !== null);
  // `encoderIntent` is overwritten to the path actually taken (not just the
  // pre-render estimate) so the toolbar's post-render line matches reality
  // even when a guard below demoted the encoder the caller asked for.
  const resolveFinalPlan = (
    path: EncoderPath,
    overlayKeying?: RenderPlan['overlayKeying'],
    wideColorWhere?: 'gpu' | 'ignored',
  ): RenderPlan => {
    const keyed: RenderPlan = {
      ...effectiveRenderPlan,
      encoderIntent: path,
      encoderReasons: [...decision.reasons, ...fallbackReasons],
      ...(hasKeyedClip && overlayKeying ? { overlayKeying } : {}),
    };
    delete keyed.refusal;
    delete keyed.videoEncoder;
    const encoder = getLastResolvedEncoderCodec();
    if ((path === 'webcodecs' || path === 'webcodecs-av') && encoder) {
      keyed.videoEncoder = {
        codec: encoder.codec,
        hardwareAcceleration: encoder.hardwareAcceleration ?? 'prefer-hardware',
      };
    }
    // Re-derived for the path actually taken, like `encoderIntent`.
    delete keyed.pictureTransform;
    delete keyed.pictureTransformGaps;
    Object.assign(keyed, pictureTransformPlanFields(clips, path));
    // Bus FX / ducks / loudness: what the audio premix reported, or `none`
    // when no premix ran for this render (the settings never reached it).
    delete keyed.audioFx;
    delete keyed.loudness;
    if (busActive) {
      const report = getLastExportAudioReport();
      Object.assign(keyed, report.audioFx ? report : { audioFx: 'none' });
    }
    return wideColorWhere
      ? stampWideColor(keyed, wideColorWhere, colorManagement)
      : keyed;
  };

  // -- The routing decision ---------------------------------------------------
  // `selectEncoderPath` is the one decision; the pre-render estimate makes the
  // same call without these runtime probes, so the two can only disagree
  // about the machine, never about the timeline.
  const needsVideoNormalize = clipsNeedResolutionNormalization(clips, settings) || forceReencode;
  const { width, height } = parseOutputResolution(settings.outputResolution);
  const burnCaptions =
    captionBurnIn && captionBurnIn.captions.length > 0
      ? captionBurnIn
      : null;
  const pathInput: EncoderPathInput = {
    clips,
    transitions,
    textOverlays,
    finishing,
    forceFFmpeg,
    useCanvas,
    webGpuAvailable,
    mediaRecorderAvailable: typeof MediaRecorder !== 'undefined',
    willReencode: needsVideoNormalize || effectiveRenderPlan.willReencode === true,
    outputColor: colorManagement.outputColor,
    burnCaptions: burnCaptions !== null,
  };
  // Probe WebCodecs only when the GPU encoder is actually the candidate.
  const webCodecsAvailable = isGpuEncodeCandidate(pathInput)
    ? await isWebCodecsAvailable(width, height)
    : false;
  let decision = selectEncoderPath({ ...pathInput, webCodecsAvailable });
  /** Runtime fallbacks taken after the decision (a failed encoder). */
  const fallbackReasons: string[] = [];
  for (const reason of decision.reasons) {
    if (reason.startsWith('Canvas renderer skipped')) {
      onStatus(`${reason}; using the GPU/FFmpeg compositor instead.`);
    }
  }

  // -- Canvas renderer path --------------------------------------------------
  // Canvas2D has no keying, transition, PiP, or finishing-pass step — it just
  // plays clips back onto a canvas (see `overlayKeying: 'unsupported'`).
  // `selectEncoderPath` never picks it for a timeline that needs those.
  if (decision.path === 'canvas') {
    try {
      onStatus('Canvas renderer path selected (audio-reactive compositing)...');
      onProgress?.({ stage: 'Canvas renderer selected', progress: 0, indeterminate: false });
      const blob = await encodeClipsWithCanvas(clips, settings, onStatus, audioReactive, onProgress);
      return {
        blob,
        path: 'canvas',
        renderPlan: resolveFinalPlan('canvas', 'unsupported', 'ignored'),
      };
    } catch (err) {
      canvasFailure = (err as Error).message;
      onStatus(`Canvas render failed (${canvasFailure}). Trying next encoder...`);
      fallbackReasons.push(`Canvas render failed: ${canvasFailure}`);
      // Decide again without the canvas request: the GPU encoder, if eligible.
      const retryInput = { ...pathInput, useCanvas: false };
      decision = selectEncoderPath({
        ...retryInput,
        webCodecsAvailable: isGpuEncodeCandidate(retryInput)
          ? await isWebCodecsAvailable(width, height)
          : false,
      });
    }
  }

  // Never write a file that silently lacks what the user asked for.
  if (decision.refusal) {
    throw new ColorPipelineExportError(decision.refusal);
  }

  // -- GPU WebCodecs path (hardware video + WebCodecs AAC or FFmpeg audio mux) -
  if (decision.path === 'webcodecs') {
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
        colorManagement,
      );
      const captionsBurnedIn = Boolean(burnCaptions);

      if (useWebCodecsAudio) {
        return {
          blob,
          path: 'webcodecs-av',
          renderPlan: resolveFinalPlan('webcodecs-av', 'gpu', 'gpu'),
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
        renderPlan: resolveFinalPlan('webcodecs', 'gpu', 'gpu'),
        captionsBurnedIn,
      };
    } catch (err) {
      if (
        isColorManagementActive(colorManagement) &&
        colorManagement.outputColor !== 'rec709-sdr'
      ) {
        if (isColorPipelineExportError(err)) throw err;
        const message = err instanceof Error ? err.message : 'GPU encode failed';
        throw new Error(
          `${message} Display P3 / HDR10 was not written as a Rec.709 file.`,
          { cause: err },
        );
      }
      gpuFailure = (err as Error).message;
      onStatus(`GPU encode failed (${gpuFailure}). Falling back to FFmpeg...`);
      fallbackReasons.push(`GPU encode failed: ${gpuFailure}`);
    }
  }

  // -- FFmpeg path (default / fallback) -------------------------------------
  if (!forceFFmpeg && !useCanvas && decision.path === 'ffmpeg' && !gpuFailure && !canvasFailure) {
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
    const keyedPlan = resolveFinalPlan('ffmpeg', 'ffmpeg', 'ignored');
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
