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
import { buildTransitionFilterComplex } from "../utils/transitions";
import {
  allVideoClipsMatchOutputResolution,
  clipsHaveMixedVideoDimensions,
  clipsNeedResolutionNormalization,
  formatOutputResolution,
  usesFixedOutputResolution,
} from "../utils/resolution";
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
  terminateFfmpegInstance,
  clearTrackedLoadingInstance,
  buildFfmpegLoadErrorMessage,
  parseFfmpegTimeSeconds,
  safeExec,
  safeWriteFile,
  safeReadFile,
  execWithFfmpegProgress,
  clipNeedsEffects,
  getSafeExtension,
  buildSingleClipFilter,
  getFfmpegEnvironmentDiagnostics,
  toBlobURLWithRetry,
  toBlobURLWithFallback,
  withTimeout,
  _doLoadFfmpeg,
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
  ffmpegInstance,
  fontLoaded,
  ffmpegLoadingInstance,
  ffmpegLoadingPromise,
  ffmpegLoadFailed,
  loadGeneration,
  StatusCallback,
  RenderProgressUpdate,
  ProgressCallback,
  FfmpegLogProgressContext,
  activeFfmpegLogProgress,
  MAX_LOG_BUFFER,
  ffmpegLogBuffer,
  lastFfmpegErrorLog,
  FFMPEG_CORE_CDNS,
  FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
  FFMPEG_LOAD_TIMEOUT_MS,
} from "./core";

export function calculateRenderPlan(
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
    let rifeClipCount = 0;
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
      if (clip.rifeProcessed) {
        rifeClipCount++;
      }
    }

    const reasonParts: string[] = [];
    if (audioClipCount > 0) reasonParts.push("are audio-only");
    if (fadeClipCount > 0) reasonParts.push("have fades");
    if (rifeClipCount > 0) reasonParts.push("are RIFE-processed");

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
