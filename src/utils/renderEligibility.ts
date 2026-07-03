import type { Clip, ClipTransition, TextOverlay } from '../types';
import { clipHasVolumeAdjustment } from './audioVolume';
import { projectHasKeyframeAnimation } from './animatedLayout';
import { isColorGradeActive, type ColorGradeSettings } from './lut';

/** Mirrors ffmpegService clipNeedsEffects — shared for encoder path selection. */
export function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === 'audio') return true;
  if (clip.rifeProcessed) return true;
  return (
    clip.videoFadeIn > 0 ||
    clip.videoFadeOut > 0 ||
    clip.audioFadeIn > 0 ||
    clip.audioFadeOut > 0 ||
    clipHasVolumeAdjustment(clip)
  );
}

export function hasActiveTransitions(transitions: ClipTransition[]): boolean {
  return transitions.some((transition) => transition.type !== 'none' && transition.duration > 0);
}

/** Timeline compositor export (preview parity) for transitions, PiP, or keyframes. */
export function shouldUseTimelineGpuExport(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  colorGrade?: ColorGradeSettings,
): boolean {
  if (hasActiveTransitions(transitions)) return true;
  if (clips.some((clip) => (clip.layerIndex ?? 0) > 0)) return true;
  if (projectHasKeyframeAnimation(clips, textOverlays)) return true;
  if (clips.some((clip) => clip.stillImage)) return true;
  if (textOverlays.length > 0 && isColorGradeActive(colorGrade)) return true;
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
    colorGrade?: ColorGradeSettings;
  } = {},
): boolean {
  if (options.forceFFmpeg || options.useCanvas) return false;
  if (shouldUseTimelineGpuExport(clips, transitions, textOverlays, options.colorGrade)) {
    return options.webGpuAvailable === true;
  }
  if (isColorGradeActive(options.colorGrade)) {
    return options.webGpuAvailable === true;
  }
  if (textOverlays.length > 0) return false;
  if (clips.some((clip) => (clip.layerIndex ?? 0) > 0)) return false;
  if (clips.some((clip) => clip.rifeProcessed)) return false;
  return true;
}
