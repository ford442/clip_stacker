import type {
  Clip,
  ExportSettings,
  ClipTransition,
  TextOverlay,
  RenderPlan,
} from "../types";
import { DEFAULT_EXPORT_SETTINGS } from "../types";
import { clipHasLoop, getClipLoopCount } from "../utils/playbackRate";
import { clipIsReversed } from "../utils/reverseClip";
import {
  allVideoClipsMatchOutputResolution,
  clipsHaveMixedVideoDimensions,
  clipsNeedResolutionNormalization,
  formatOutputResolution,
  usesFixedOutputResolution,
} from "../utils/resolution";
import {
  isFinishingActive,
  isBloomActive,
  isChromaticAberrationActive,
  isCurvesActive,
  isLutFinishingPassActive,
  type FinishingSettings,
} from "../utils/finishing";
import { secondaryHasWindowGrades } from "../utils/secondaryColor";
import { isStabilizationActive } from "../utils/stabilization";
import { resolveLayerKey } from "../utils/overlayKey";
import { pictureTransformPlanFields } from "../utils/renderEligibility";
import { clipHasPictureTransform } from "../utils/animatedLayout";
import { selectEncoderPath } from "../utils/encoderPath";
import type { OutputColor } from "../utils/colorManagement";
import {
  clipNeedsEffects,
  isStillImageClip,
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
  /** Result of `isWebCodecsAvailable(w, h)` — undefined: assumed iff WebGPU is. */
  webCodecsAvailable?: boolean;
  /** MediaRecorder exists — undefined: assumed. */
  mediaRecorderAvailable?: boolean;
  /** Export setting "Force re-encode". */
  forceReencode?: boolean;
  /** Requested output colour (HDR10 + text is refused, see `hdr10TextRefusal`). */
  outputColor?: OutputColor;
  captionMode?: 'none' | 'burn' | 'soft';
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

  // The same decision `hybridMergeClips` makes, minus its runtime probes.
  const decision = selectEncoderPath({
    clips,
    transitions,
    textOverlays,
    finishing: context.finishing,
    forceFFmpeg: context.forceFFmpeg,
    useCanvas: context.useCanvasRenderer,
    webGpuAvailable: context.webGpuAvailable,
    webCodecsAvailable: context.webCodecsAvailable,
    mediaRecorderAvailable: context.mediaRecorderAvailable,
    willReencode:
      plan.willReencode ||
      context.forceReencode === true ||
      clipsNeedResolutionNormalization(clips, settings),
    outputColor: context.outputColor,
    burnCaptions: context.captionMode === 'burn',
  });
  const encoderIntent = decision.path;
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
    if (isCurvesActive(context.finishing?.curves)) {
      ffmpegFinishingGaps.push('Curves & levels');
    }
    if (isLutFinishingPassActive(context.finishing?.lut)) {
      ffmpegFinishingGaps.push('Creative LUT');
    }
    if (secondaryHasWindowGrades(context.finishing?.secondaryColor)) {
      ffmpegFinishingGaps.push('Secondary color window grades');
    }
    if (isChromaticAberrationActive(context.finishing?.chromaticAberration)) {
      ffmpegFinishingGaps.push('Chromatic aberration');
    }
    if (isBloomActive(context.finishing?.bloom)) {
      ffmpegFinishingGaps.push('Bloom & glow');
    }
  }

  return {
    ...plan,
    ...(shaderOverlays.length > 0
      ? { shaderTextOverlays: shaderOverlays.map((o) => ({ id: o.id, text: o.text })) }
      : {}),
    encoderIntent,
    encoderReasons: decision.reasons,
    ...(decision.refusal ? { refusal: decision.refusal } : {}),
    finishingActive,
    stabilizeActive,
    ...(overlayKeying ? { overlayKeying } : {}),
    ...pictureTransformPlanFields(clips, encoderIntent),
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

  // A rotated / scaled clip goes through the same compositing graph.
  if (clips.some(clipHasPictureTransform)) {
    return {
      path: "pip",
      reason: "Clip picture transform (rotation / scale) detected",
      willReencode: true,
      description: "Re-encoding with picture transforms (re-encode)",
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
    let reverseClipCount = 0;
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
      if (clipIsReversed(clip)) reverseClipCount++;
    }

    const reasonParts: string[] = [];
    if (audioClipCount > 0) reasonParts.push("are audio-only");
    if (fadeClipCount > 0) reasonParts.push("have fades");
    if (volumeClipCount > 0) reasonParts.push("have volume adjustments");
    if (speedClipCount > 0) reasonParts.push("have speed adjustments");
    if (rifeClipCount > 0) reasonParts.push("are RIFE-processed");
    if (reverseClipCount > 0) reasonParts.push("are reversed");
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
