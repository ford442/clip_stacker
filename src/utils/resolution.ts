import type { ExportSettings } from '../types';

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

export function usesFixedOutputResolution(settings: ExportSettings): boolean {
  return settings.resolutionPreset !== 'original' && settings.outputResolution !== 'original';
}

export function formatOutputResolution(settings: ExportSettings): string {
  if (!usesFixedOutputResolution(settings)) return 'auto';
  const { width, height } = parseOutputResolution(settings.outputResolution);
  return `${width}x${height}`;
}
