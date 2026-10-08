import { EXPORT_PRESETS, type Clip, type ClipAnimatableProp, type ExportSettings } from '../../types';
import type { ClipValues } from './types';
import type { PictureTransformProp } from '../../utils/animatedLayout';

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

/**
 * Picture-transform lanes (`utils/clipTransform.ts`). Keyframe-only: an
 * omitted lane is identity, so these default to the identity values.
 */
export const TRANSFORM_KEYFRAME_PROPS: Array<{
  prop: PictureTransformProp;
  label: string;
  step: number;
  min?: number;
  max?: number;
  defaultValue: number;
  title: string;
}> = [
  { prop: 'scaleX', label: 'Scale X', step: 0.01, min: 0.01, max: 10, defaultValue: 1, title: 'Horizontal scale of the picture about its anchor. 1 = unchanged.' },
  { prop: 'scaleY', label: 'Scale Y', step: 0.01, min: 0.01, max: 10, defaultValue: 1, title: 'Vertical scale of the picture about its anchor. 1 = unchanged.' },
  { prop: 'rotation', label: 'Rotation (°)', step: 1, min: -360, max: 360, defaultValue: 0, title: 'Clockwise rotation about the anchor, in degrees. The picture may extend past its layout rect.' },
  { prop: 'anchorX', label: 'Anchor X', step: 0.05, min: 0, max: 1, defaultValue: 0.5, title: 'Pivot for scale and rotation, 0 = left edge, 1 = right edge of the layout rect.' },
  { prop: 'anchorY', label: 'Anchor Y', step: 0.05, min: 0, max: 1, defaultValue: 0.5, title: 'Pivot for scale and rotation, 0 = top edge, 1 = bottom edge of the layout rect.' },
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
