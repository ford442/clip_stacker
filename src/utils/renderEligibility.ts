import type { Clip, ClipTransition, RenderPlan, TextOverlay } from '../types';
import { clipHasVolumeAdjustment } from './audioVolume';
import { clipHasLoop, clipHasPlaybackRateAdjustment } from './playbackRate';
import { clipIsReversed } from './reverseClip';
import { clipHasRateAutomation } from './timeRemap';
import {
  clipHasAnimatedPictureTransform,
  clipHasKeyframes,
  clipHasPictureTransform,
} from './animatedLayout';
import { isStabilizationActive } from './stabilization';
import { isFinishingActive, type FinishingSettings } from './finishing';
import { resolveLayerKey } from './overlayKey';

/** Mirrors ffmpegService clipNeedsEffects — shared for encoder path selection. */
export function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === 'audio') return true;
  if (clip.rifeProcessed) return true;
  return (
    clip.videoFadeIn > 0 ||
    clip.videoFadeOut > 0 ||
    clip.audioFadeIn > 0 ||
    clip.audioFadeOut > 0 ||
    clipHasVolumeAdjustment(clip) ||
    clipHasPlaybackRateAdjustment(clip) ||
    clipHasRateAutomation(clip) ||
    clipHasLoop(clip) ||
    clipIsReversed(clip)
  );
}

export function hasActiveTransitions(transitions: ClipTransition[]): boolean {
  return transitions.some((transition) => transition.type !== 'none' && transition.duration > 0);
}

export function hasShaderTextOverlays(textOverlays: TextOverlay[]): boolean {
  return textOverlays.some((overlay) => overlay.fill === 'shader');
}

/** True when any overlay uses Canvas2D solid fill (not a GPU shader fill). */
export function hasSolidTextOverlays(textOverlays: TextOverlay[]): boolean {
  return textOverlays.some((overlay) => overlay.fill !== 'shader');
}

/**
 * Shader-only overlays with no boxes can be blitted onto the WebGPU canvas
 * and captured directly, skipping the extra 2D video copy.
 */
export function canCaptureWebGpuCanvasWithText(
  textOverlays: TextOverlay[],
): boolean {
  if (textOverlays.length === 0) return true;
  return textOverlays.every(
    (overlay) => overlay.fill === 'shader' && !overlay.box,
  );
}

/**
 * Transitions, PiP, clip keyframes, still images, and looped clips need
 * multi-source frame delivery (timeline compositor) — the plain sequential
 * WebCodecs path (`encodeVideoFrames`) walks each clip's trim window once
 * and has no loop-wrap or speed awareness, so a looped clip or any clip
 * whose playback rate is not 1× must route through the compositor's
 * `buildPreviewCompositionPlan` (source time is the integral of the rate,
 * wrapped per loop). That is the same clock the timeline preview uses, so
 * export does not keep 1× frames inside a resized clip. Text overlay
 * keyframes are resolved in the overlay post-pass via
 * `buildPreviewCompositionPlan`.
 */
export function needsMultiLayerComposition(
  clips: Clip[],
  transitions: ClipTransition[],
): boolean {
  if (hasActiveTransitions(transitions)) return true;
  if (clips.some((clip) => (clip.layerIndex ?? 0) > 0)) return true;
  if (clips.some(clipHasKeyframes)) return true;
  if (clips.some((clip) => clip.stillImage)) return true;
  if (clips.some(clipHasLoop)) return true;
  if (clips.some(clipHasRateAutomation)) return true;
  if (clips.some(clipHasPlaybackRateAdjustment)) return true;
  if (clips.some(clipIsReversed)) return true;
  return false;
}

/** Solid text overlays are rasterized in a post-pass over decoder output. */
export function needsOverlayPass(
  textOverlays: TextOverlay[],
  _finishing?: FinishingSettings,
): boolean {
  if (textOverlays.length === 0) return false;
  return !hasShaderTextOverlays(textOverlays);
}

/** Timeline compositor export (preview parity) for multi-layer or shader text. */
export function shouldUseTimelineGpuExport(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  _finishing?: FinishingSettings,
): boolean {
  if (needsMultiLayerComposition(clips, transitions)) return true;
  // Shader fills use WebGPU readback on the timeline compositor path.
  if (hasShaderTextOverlays(textOverlays)) return true;
  return false;
}

/** Whether the browser GPU video encoder can handle this render job. */
export function canUseGpuVideoEncoder(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  options: {
    forceFFmpeg?: boolean;
    useCanvas?: boolean;
    webGpuAvailable?: boolean;
    /** @deprecated Prefer `finishing`. */
    colorGrade?: import('./lut').ColorGradeSettings;
    finishing?: FinishingSettings;
  } = {},
): boolean {
  const finishing = options.finishing;
  const legacyGrade = options.colorGrade;
  const effectiveFinishing =
    finishing ??
    (legacyGrade
      ? {
          lut: {
            enabled: legacyGrade.lutId !== 'none' && legacyGrade.intensity > 0,
            lutId: legacyGrade.lutId,
            intensity: legacyGrade.intensity,
          },
        }
      : undefined);

  if (options.forceFFmpeg || options.useCanvas) return false;
  if (shouldUseTimelineGpuExport(clips, transitions, textOverlays, effectiveFinishing)) {
    return options.webGpuAvailable === true;
  }
  if (isFinishingActive(effectiveFinishing)) {
    return options.webGpuAvailable === true;
  }
  if (clips.some((clip) => clip.rifeProcessed)) return false;
  return true;
}

/**
 * Render-plan fields for clip picture transforms, for the encoder that ran
 * (or is expected to). Empty when no clip is transformed.
 *
 * The compositors (WebGPU and Canvas2D) sample through the composed layer
 * warp, so they match the preview. FFmpeg only gets `scale` + `rotate`, and
 * says what that loses instead of exporting a different picture silently.
 * The MediaRecorder canvas encoder is never chosen for a transformed clip
 * (see `hybridMergeClips`), so it maps to nothing here.
 */
export function pictureTransformPlanFields(
  clips: Clip[],
  encoder: RenderPlan['encoderIntent'],
): Pick<RenderPlan, 'pictureTransform' | 'pictureTransformGaps'> {
  const transformed = clips.filter(clipHasPictureTransform);
  if (transformed.length === 0 || encoder === 'canvas' || !encoder) return {};
  if (encoder !== 'ffmpeg') return { pictureTransform: 'gpu' };

  const gaps: string[] = [];
  if (transformed.some((clip) => isStabilizationActive(clip))) {
    gaps.push(
      'Stabilization on rotated / scaled clips (FFmpeg has no libvidstab, so the optical-flow warp is dropped)',
    );
  }
  if (transformed.some(clipHasAnimatedPictureTransform)) {
    gaps.push('Animated rotation / scale (FFmpeg holds the first keyframe)');
  }
  return {
    pictureTransform: 'ffmpeg',
    ...(gaps.length > 0 ? { pictureTransformGaps: gaps } : {}),
  };
}

/**
 * What the remote concat (`handleGpuStitch`) would silently drop for this
 * timeline. It has no compositor — it trims each base clip with its own audio
 * and stitches them end to end — so any of these makes it refuse.
 */
export function remoteConcatDroppedFeatures(
  timelineClips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  finishing: FinishingSettings,
  captionCount: number,
): string[] {
  const dropped: string[] = [];
  if (timelineClips.some((clip) => (clip.layerIndex ?? 0) > 0)) dropped.push('PiP/overlay lanes');
  if (hasActiveTransitions(transitions)) dropped.push('transitions');
  if (textOverlays.length > 0) dropped.push('text overlays');
  if (isFinishingActive(finishing)) dropped.push('finishing');
  if (timelineClips.some((clip) => resolveLayerKey(clip) !== null)) dropped.push('chroma/luma keys');
  if (captionCount > 0) dropped.push('captions');
  // A muted lane's clips would still be trimmed with their audio.
  if (timelineClips.some((clip) => clip.kind === 'video' && clip.trackMuted)) dropped.push('lane mute');
  return dropped;
}
