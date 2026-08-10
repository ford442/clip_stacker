import type { Clip, ClipTransition, TextOverlay } from '../types';
import { clipHasVolumeAdjustment } from './audioVolume';
import { clipHasPlaybackRateAdjustment } from './playbackRate';
import { clipHasKeyframes } from './animatedLayout';
import { isFinishingActive, type FinishingSettings } from './finishing';

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
    clipHasPlaybackRateAdjustment(clip)
  );
}

export function hasActiveTransitions(transitions: ClipTransition[]): boolean {
  return transitions.some((transition) => transition.type !== 'none' && transition.duration > 0);
}

export function hasShaderTextOverlays(textOverlays: TextOverlay[]): boolean {
  return textOverlays.some((overlay) => overlay.fill === 'shader');
}

/**
 * Transitions, PiP, clip keyframes, and still images need multi-source frame
 * delivery (timeline compositor). Text overlay keyframes are resolved in the
 * overlay post-pass via `buildPreviewCompositionPlan`.
 */
export function needsMultiLayerComposition(
  clips: Clip[],
  transitions: ClipTransition[],
): boolean {
  if (hasActiveTransitions(transitions)) return true;
  if (clips.some((clip) => (clip.layerIndex ?? 0) > 0)) return true;
  if (clips.some(clipHasKeyframes)) return true;
  if (clips.some((clip) => clip.stillImage)) return true;
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
