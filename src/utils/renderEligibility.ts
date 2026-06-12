import type { Clip, ClipTransition, TextOverlay } from '../types';

/** Mirrors ffmpegService clipNeedsEffects — shared for encoder path selection. */
export function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === 'audio') return true;
  if (clip.rifeProcessed) return true;
  return clip.videoFadeIn > 0 || clip.videoFadeOut > 0 || clip.audioFadeIn > 0 || clip.audioFadeOut > 0;
}

export function hasActiveTransitions(transitions: ClipTransition[]): boolean {
  return transitions.some((transition) => transition.type !== 'none' && transition.duration > 0);
}

/** Whether the browser GPU video encoder can handle this render job. */
export function canUseGpuVideoEncoder(
  clips: Clip[],
  transitions: ClipTransition[],
  textOverlays: TextOverlay[],
  options: { forceFFmpeg?: boolean; useCanvas?: boolean } = {},
): boolean {
  if (options.forceFFmpeg || options.useCanvas) return false;
  if (hasActiveTransitions(transitions)) return false;
  if (textOverlays.length > 0) return false;
  if (clips.some((clip) => (clip.layerIndex ?? 0) > 0)) return false;
  if (clips.some((clip) => clip.rifeProcessed)) return false;
  return true;
}
