import type { Clip } from '../types';

/** Native playback level (1 = 100%). */
export const DEFAULT_CLIP_VOLUME = 1;
export const MIN_CLIP_VOLUME = 0;
export const MAX_CLIP_VOLUME = 2;

export function clampClipVolume(volume: number | undefined): number {
  const value = volume ?? DEFAULT_CLIP_VOLUME;
  if (!Number.isFinite(value)) return DEFAULT_CLIP_VOLUME;
  return Math.min(MAX_CLIP_VOLUME, Math.max(MIN_CLIP_VOLUME, value));
}

export function getClipVolume(clip: Pick<Clip, 'volume'>): number {
  return clampClipVolume(clip.volume);
}

export function clipHasVolumeAdjustment(clip: Pick<Clip, 'volume'>): boolean {
  return getClipVolume(clip) !== DEFAULT_CLIP_VOLUME;
}

/** FFmpeg `volume` filter segment to append inside an audio filter chain. */
export function audioVolumeFilterSegment(volume: number): string {
  const clamped = clampClipVolume(volume);
  return clamped === DEFAULT_CLIP_VOLUME ? '' : `,volume=${clamped.toFixed(4)}`;
}
