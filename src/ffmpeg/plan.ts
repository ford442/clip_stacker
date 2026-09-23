import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type {
  Clip,
  ExportSettings,
  ClipTransition,
  TextOverlay,
  RenderPlan,
} from "../types";
import { DEFAULT_EXPORT_SETTINGS } from "../types";
import { getClipDuration } from "../utils/project";
import { clipHasLoop, getClipLoopCount } from "../utils/playbackRate";
import { buildTransitionFilterComplex } from "../utils/transitions";
import {
  allVideoClipsMatchOutputResolution,
  clipsHaveMixedVideoDimensions,
  clipsNeedResolutionNormalization,
  formatOutputResolution,
  usesFixedOutputResolution,
} from "../utils/resolution";
import {
  isFinishingActive,
  isLutFinishingPassActive,
  type FinishingSettings,
} from "../utils/finishing";
import { secondaryHasWindowGrades } from "../utils/secondaryColor";
import { isStabilizationActive } from "../utils/stabilization";
import { resolveLayerKey } from "../utils/overlayKey";
import { canUseGpuVideoEncoder, hasActiveTransitions } from "../utils/renderEligibility";
import {
  isFfmpegLoadFailed,
  isFfmpegLoading,
  recordFfmpegLog,
  getLastFfmpegLogs,
  getLastFfmpegError,
  clearFfmpegLogs,
  buildDetailedError,
  extractErrorMessage,
  clampProgress,
  emitProgress,
  emitLoadStatus,
  getCdnLabel,
  getLocalFfmpegCoreBaseURL,
  getFfmpegCoreSources,
  buildFfmpegLoadErrorMessage,
  parseFfmpegTimeSeconds,
  safeExec,
  safeWriteFile,
  safeReadFile,
  execWithFfmpegProgress,
  clipNeedsEffects,
  getSafeExtension,
  isStillImageClip,
  buildSingleClipFilter,
  getFfmpegEnvironmentDiagnostics,
  toBlobURLWithRetry,
  toBlobURLWithFallback,
  withTimeout,
  ensureFfmpeg,
  ensureFont,
  buildDrawtextFilter,
  mergeClipsLossless,
  performTwoPassEncode,
  processClipPass1,
  mergeClipsPass2,
  mergeClipsWithTransitions,
  DEFAULT_VIDEO_SIZE,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  PASS1_PROGRESS_START,
  PASS1_PROGRESS_END,
  FONT_CDN_URL,
  FONT_VIRTUAL_NAME,
  StatusCallback,
  RenderProgressUpdate,
  ProgressCallback,
  FfmpegLogProgressContext,
  MAX_LOG_BUFFER,
  FFMPEG_CORE_CDNS,
  FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
  FFMPEG_LOAD_TIMEOUT_MS,
} from "./core";

/**
 * Extra context `calculateRenderPlan` needs to estimate which encoder will
 * actually run — none of it is derivable from `clips`/`transitions`/
 * `textOverlays`/`settings` alone. All optional so existing callers (and
 * tests) that only care about the FFmpeg concat/reencode strategy keep
 * working unchanged.
 */
export interface RenderPlanContext {
  finishing?: FinishingSettings;
  forceFFmpeg?: boolean;
  useCanvasRenderer?: boolean;
  /** Result of `isWebGpuExportAvailable()` — undefined means "not probed yet". */
  webGpuAvailable?: boolean;
  captionMode?: 'none' | 'burn' | 'soft';
}

/**
 * Mirrors the encoder selection in `utils/hybrid-encoder.ts` (`hybridMergeClips`)
 * closely enough to predict, before encoding starts, which path it will pick.
 * Kept intentionally conservative: anything this can't be sure about falls
 * through to `'ffmpeg'`, same as the runtime fallback.
 */
function estimateEncoderIntent(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  context: RenderPlanContext,
): RenderPlan['encoderIntent'] {
  const { forceFFmpeg = false, useCanvasRenderer = false, webGpuAvailable, finishing } = context;

  if (useCanvasRenderer) {
    // Mirrors hybridMergeClips's canvas-compatibility guard: Canvas2D has no
    // keying, transition, PiP, or finishing pass, so those demote it to the
    // GPU/FFmpeg estimate below instead of silently dropping them.
    const hasKeyedClip = clips.some((clip) => resolveLayerKey(clip) !== null);
    const hasPipClip = clips.some((clip) => (clip.layerIndex ?? 0) > 0);
    if (!hasKeyedClip && !hasPipClip && !hasActiveTransitions(transitions) && !isFinishingActive(finishing)) {
      return 'canvas';
    }
  }

  if (forceFFmpeg) return 'ffmpeg';

  const gpuEligible = canUseGpuVideoEncoder(clips, transitions, textOverlays, {
    forceFFmpeg,
    useCanvas: false,
    webGpuAvailable,
    finishing,
  });
  if (gpuEligible && webGpuAvailable) return 'webcodecs';
  return 'ffmpeg';
}

export function calculateRenderPlan(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
  context: RenderPlanContext = {},
): RenderPlan {
  const plan = computeRenderPlanPath(clips, transitions, textOverlays, settings);
  const shaderOverlays = textOverlays.filter((o) => o.fill === "shader");

  const encoderIntent = estimateEncoderIntent(clips, transitions, textOverlays, context);
  const finishingActive = isFinishingActive(context.finishing);
  const stabilizeActive = clips.some((clip) => isStabilizationActive(clip));
  const hasKeyedClip = clips.some((clip) => resolveLayerKey(clip) !== null);
  const overlayKeying: RenderPlan['overlayKeying'] = hasKeyedClip
    ? encoderIntent === 'canvas'
      ? 'unsupported'
      : encoderIntent === 'ffmpeg'
        ? 'ffmpeg'
        : 'gpu'
    : undefined;
  const shaderTextFallbackRisk =
    shaderOverlays.length > 0 && (encoderIntent === 'ffmpeg' || encoderIntent === 'canvas');

  const ffmpegFinishingGaps: string[] = [];
  if (encoderIntent === 'ffmpeg') {
    if (isLutFinishingPassActive(context.finishing?.lut)) {
      ffmpegFinishingGaps.push('Creative LUT');
    }
    if (secondaryHasWindowGrades(context.finishing?.secondaryColor)) {
      ffmpegFinishingGaps.push('Secondary color window grades');
    }
  }

  return {
    ...plan,
    ...(shaderOverlays.length > 0
      ? { shaderTextOverlays: shaderOverlays.map((o) => ({ id: o.id, text: o.text })) }
      : {}),
    encoderIntent,
    finishingActive,
    stabilizeActive,
    ...(overlayKeying ? { overlayKeying } : {}),
    ...(context.captionMode !== undefined ? { captionMode: context.captionMode } : {}),
    ...(shaderTextFallbackRisk ? { shaderTextFallbackRisk: true } : {}),
    ...(ffmpegFinishingGaps.length > 0 ? { ffmpegFinishingGaps } : {}),
  };
}

function computeRenderPlanPath(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): RenderPlan {
  // Check for PiP clips
  const hasPipClips = clips.some((c) => (c.layerIndex ?? 0) > 0);
  if (hasPipClips) {
    return {
      path: "pip",
      reason: "Picture-in-Picture compositing detected",
      willReencode: true,
      description: "Re-encoding with PiP compositing (re-encode)",
    };
  }

  // Check for transitions
  const activeTransitions = transitions.filter(
    (t) => t.type !== "none" && t.duration > 0,
  );
  if (activeTransitions.length > 0) {
    return {
      path: "transitions",
      reason: `${activeTransitions.length} transition${activeTransitions.length > 1 ? "s" : ""} enabled`,
      willReencode: true,
      description: "Re-encoding with transitions (re-encode)",
    };
  }

  // Check for text overlays
  if (textOverlays.length > 0) {
    return {
      path: "textoverlays",
      reason: `${textOverlays.length} text overlay${textOverlays.length > 1 ? "s" : ""} present`,
      willReencode: true,
      description: "Re-encoding with text overlays (re-encode)",
    };
  }

  // Check for clips that need effects
  const effectClips = clips.filter(clipNeedsEffects);
  if (effectClips.length > 0) {
    // Count audio and fade clips in a single pass
    let audioClipCount = 0;
    let fadeClipCount = 0;
    let volumeClipCount = 0;
    let speedClipCount = 0;
    let rifeClipCount = 0;
    let loopClipCount = 0;
    let soleLoopCount: number | null = null;
    for (const clip of effectClips) {
      if (clip.kind === "audio") {
        audioClipCount++;
      }
      if (
        clip.videoFadeIn > 0 ||
        clip.videoFadeOut > 0 ||
        clip.audioFadeIn > 0 ||
        clip.audioFadeOut > 0
      ) {
        fadeClipCount++;
      }
      if ((clip.volume ?? 1) !== 1) {
        volumeClipCount++;
      }
      if ((clip.playbackRate ?? 1) !== 1) {
        speedClipCount++;
      }
      if (clip.rifeProcessed) {
        rifeClipCount++;
      }
      if (clipHasLoop(clip)) {
        loopClipCount++;
        soleLoopCount = getClipLoopCount(clip);
      }
    }

    const reasonParts: string[] = [];
    if (audioClipCount > 0) reasonParts.push("are audio-only");
    if (fadeClipCount > 0) reasonParts.push("have fades");
    if (volumeClipCount > 0) reasonParts.push("have volume adjustments");
    if (speedClipCount > 0) reasonParts.push("have speed adjustments");
    if (rifeClipCount > 0) reasonParts.push("are RIFE-processed");
    if (loopClipCount > 0) {
      reasonParts.push(
        loopClipCount === 1 && soleLoopCount != null
          ? `is looped ${soleLoopCount}×`
          : "are looped",
      );
    }

    let reasonDetail = reasonParts.join(" and/or ");
    if (effectClips.length === 1) {
      reasonDetail = reasonDetail
        .replace(/\bare\b/g, "is")
        .replace(/\bhave\b/g, "has");
    }
    if (!reasonDetail) {
      reasonDetail = "require re-encoding";
    }

    const titles = effectClips.map((c) => `"${c.title}"`).join(", ");
    return {
      path: "effects-reencoding",
      reason: `${effectClips.length > 1 ? "Clips" : "Clip"} ${titles} ${reasonDetail}`,
      willReencode: true,
      description: `Re-encoding ${titles} with CRF ${settings.crf} (${settings.preset} preset)`,
    };
  }

  const stillClips = clips.filter(isStillImageClip);
  if (stillClips.length > 0) {
    const titles = stillClips.map((c) => `"${c.title}"`).join(", ");
    return {
      path: "effects-reencoding",
      reason:
        stillClips.length === 1
          ? `Still image ${titles} must be encoded as H.264 video before concat`
          : `Still images ${titles} must be encoded as H.264 video before concat`,
      willReencode: true,
      description: `Re-encoding still image clips with CRF ${settings.crf} (${settings.preset} preset)`,
    };
  }

  const needsResolutionNormalization = clipsNeedResolutionNormalization(
    clips,
    settings,
  );
  if (needsResolutionNormalization) {
    const hasMixedNativeDimensions = clipsHaveMixedVideoDimensions(clips);
    const fixedOutput = usesFixedOutputResolution(settings);
    const outputResolution = formatOutputResolution(settings);
    const alreadyMatch = fixedOutput && allVideoClipsMatchOutputResolution(clips, settings);
    return {
      path: "effects-reencoding",
      reason: alreadyMatch
        ? `All clips already match the configured export resolution (${outputResolution})`
        : hasMixedNativeDimensions
          ? "Clips have different native resolutions and must be normalized before concat"
          : `Clips must be normalized to ${outputResolution} before concat`,
      willReencode: true,
      description: `Re-encoding clips with CRF ${settings.crf} (${settings.preset} preset)`,
    };
  }

  // All clips are clean with no effects — use fast lossless stream copy + concat.
  // If clips need resolution normalization, enable "Force re-encode" in export settings.
  return {
    path: "lossless-concat",
    reason:
      clips.length === 1
        ? "Single clean video clip with no effects"
        : usesFixedOutputResolution(settings)
          ? `All clips already match the configured export resolution (${formatOutputResolution(settings)})`
          : "All clips are clean with no effects",
    willReencode: false,
    description: "Lossless concat (fast, no quality loss)",
  };
}
