import type { Clip, ExportSettings } from '../types';

export const DEFAULT_OUTPUT_WIDTH = 1280;
export const DEFAULT_OUTPUT_HEIGHT = 720;

export interface OutputResolution {
  width: number;
  height: number;
}

export function parseOutputResolution(value?: string): OutputResolution {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec((value ?? '').trim());
  if (!match) {
    return { width: DEFAULT_OUTPUT_WIDTH, height: DEFAULT_OUTPUT_HEIGHT };
  }

  const rawWidth = Number(match[1]);
  const rawHeight = Number(match[2]);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) {
    return { width: DEFAULT_OUTPUT_WIDTH, height: DEFAULT_OUTPUT_HEIGHT };
  }

  // yuv420p encoders require even dimensions.
  return {
    width: Math.max(2, Math.floor(rawWidth / 2) * 2),
    height: Math.max(2, Math.floor(rawHeight / 2) * 2),
  };
}

function isExplicitResolutionValue(value?: string): boolean {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (!trimmed || trimmed === 'original' || trimmed === 'auto') return false;
  return /^(\d{2,5})x(\d{2,5})$/i.test(trimmed);
}

export function usesFixedOutputResolution(settings: ExportSettings): boolean {
  if (settings.resolutionPreset === 'original') return false;
  return isExplicitResolutionValue(settings.outputResolution);
}

/** True when timeline video clips do not share the same native dimensions. */
export function clipsHaveMixedVideoDimensions(clips: Clip[]): boolean {
  const sizes = clips
    .filter((clip) => clip.kind === 'video' && clip.videoWidth && clip.videoHeight)
    .map((clip) => `${clip.videoWidth}x${clip.videoHeight}`);

  if (sizes.length < 2) return false;
  return new Set(sizes).size > 1;
}

export function clipMatchesOutputResolution(clip: Clip, settings: ExportSettings): boolean {
  if (clip.kind !== 'video' || !clip.videoWidth || !clip.videoHeight) return false;
  const { width, height } = parseOutputResolution(settings.outputResolution);
  return clip.videoWidth === width && clip.videoHeight === height;
}

/** True when every video clip already matches the configured export resolution. */
export function allVideoClipsMatchOutputResolution(clips: Clip[], settings: ExportSettings): boolean {
  const videoClips = clips.filter((clip) => clip.kind === 'video');
  if (videoClips.length === 0) return false;
  return videoClips.every((clip) => clipMatchesOutputResolution(clip, settings));
}

/** True when any clip must be scaled before concat to keep output dimensions consistent. */
export function clipsNeedResolutionNormalization(clips: Clip[], settings: ExportSettings): boolean {
  const videoClips = clips.filter((clip) => clip.kind === 'video');
  if (videoClips.length === 0) return false;
  if (clipsHaveMixedVideoDimensions(clips)) return true;
  if (!usesFixedOutputResolution(settings)) return false;
  return videoClips.some((clip) => !clipMatchesOutputResolution(clip, settings));
}

export function formatOutputResolution(settings: ExportSettings): string {
  if (!usesFixedOutputResolution(settings)) return 'auto';
  const { width, height } = parseOutputResolution(settings.outputResolution);
  return `${width}x${height}`;
}
