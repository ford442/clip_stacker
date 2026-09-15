import { EXPORT_PRESETS, type Clip, type ClipAnimatableProp, type ExportSettings } from '../../types';
import type { ClipValues } from './types';

export const PIP_KEYFRAME_PROPS: Array<{
  prop: ClipAnimatableProp;
  label: string;
  step: number;
  min?: number;
  max?: number;
  defaultValue: (clip: Clip) => number;
}> = [
  { prop: 'x', label: 'X position', step: 1, defaultValue: (c) => c.x ?? 0 },
  { prop: 'y', label: 'Y position', step: 1, defaultValue: (c) => c.y ?? 0 },
  {
    prop: 'width',
    label: 'Width',
    step: 1,
    min: 0,
    defaultValue: (c) => c.width ?? 0,
  },
  {
    prop: 'height',
    label: 'Height',
    step: 1,
    min: 0,
    defaultValue: (c) => c.height ?? 0,
  },
  { prop: 'opacity', label: 'Opacity', step: 0.05, min: 0, max: 1, defaultValue: (c) => c.opacity ?? 1 },
];

export const KEN_BURNS_PROPS: Array<{
  prop: ClipAnimatableProp;
  label: string;
  step: number;
  min?: number;
  max?: number;
  defaultValue: number;
}> = [
  { prop: 'uvScaleX', label: 'Zoom X', step: 0.01, min: 0.1, max: 2, defaultValue: 1 },
  { prop: 'uvScaleY', label: 'Zoom Y', step: 0.01, min: 0.1, max: 2, defaultValue: 1 },
  { prop: 'uvOffsetX', label: 'Pan X', step: 0.01, min: -1, max: 1, defaultValue: 0 },
  { prop: 'uvOffsetY', label: 'Pan Y', step: 0.01, min: -1, max: 1, defaultValue: 0 },
];

export const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

export const DEFAULT_LAYOUT_VALUES = {
  layerIndex: 0,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  opacity: 1,
  volume: 1,
  playbackRate: 1,
} as const;

export const MIN_INSPECTOR_THUMBNAILS = 4;
export const MAX_INSPECTOR_THUMBNAILS = 8;
export const SECONDS_PER_INSPECTOR_THUMBNAIL = 3;
export const INSPECTOR_WAVEFORM_SAMPLES = 120;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatSeconds(value: number): string {
  return String(Number(value.toFixed(2)));
}

export function hasAdvancedLayoutValues(values: Pick<ClipValues, 'layerIndex' | 'x' | 'y' | 'width' | 'height' | 'opacity'>): boolean {
  return (
    parseNumber(values.layerIndex, 0) > DEFAULT_LAYOUT_VALUES.layerIndex ||
    parseNumber(values.x, 0) !== DEFAULT_LAYOUT_VALUES.x ||
    parseNumber(values.y, 0) !== DEFAULT_LAYOUT_VALUES.y ||
    parseNumber(values.width, 0) !== DEFAULT_LAYOUT_VALUES.width ||
    parseNumber(values.height, 0) !== DEFAULT_LAYOUT_VALUES.height ||
    parseNumber(values.opacity, 1) !== DEFAULT_LAYOUT_VALUES.opacity
  );
}

/**
 * Find the preset that matches the given export settings.
 * Returns the preset name if found, otherwise returns 'custom'.
 */
export function findMatchingPreset(settings: ExportSettings): string {
  return EXPORT_PRESETS.find(
    p => p.crf === settings.crf && p.preset === settings.preset && p.videoBitrate === settings.videoBitrate
  )?.name || 'custom';
}
