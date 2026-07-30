import type { Clip, TextOverlay } from '../types';
import type { ClipAnimatableProp, TextAnimatableProp } from '../types';
import { upsertKeyframe } from './keyframes';
import {
  clipLayoutPixelsToNormalized,
  textOverlayPixelsToNormalized,
  type CanvasSize,
} from './overlayCoords';

const KEYFRAME_MERGE_EPSILON = 0.02;

export interface PositionEditResult<T> {
  value: T;
  /** True when a keyframe at the playhead was edited instead of the base value. */
  editedKeyframe: boolean;
}

/**
 * Update clip PiP layout at the playhead. When x/y/width/height are keyframed,
 * edits the nearest keyframe at the playhead (or inserts one).
 */
export function applyClipLayoutAtPlayhead(
  clip: Clip,
  pixels: { x: number; y: number; width: number; height: number },
  canvas: CanvasSize,
  localTime: number,
): PositionEditResult<Clip> {
  const normalized = clipLayoutPixelsToNormalized(pixels, canvas, true);
  const kf = clip.keyframes;
  let editedKeyframe = false;
  const nextKeyframes = kf ? { ...kf } : undefined;

  const props: Array<{
    prop: ClipAnimatableProp;
    value: number;
    dimension: number;
  }> = [
    { prop: 'x', value: normalized.x ?? 0, dimension: canvas.width },
    { prop: 'y', value: normalized.y ?? 0, dimension: canvas.height },
    { prop: 'width', value: normalized.width ?? 0, dimension: canvas.width },
    { prop: 'height', value: normalized.height ?? 0, dimension: canvas.height },
  ];

  for (const { prop, value } of props) {
    if (kf?.[prop]?.length) {
      editedKeyframe = true;
      nextKeyframes![prop] = upsertKeyframe(
        kf[prop],
        localTime,
        value,
        KEYFRAME_MERGE_EPSILON,
      );
    }
  }

  if (editedKeyframe && nextKeyframes) {
    return {
      value: {
        ...clip,
        keyframes: nextKeyframes,
        ...(!kf?.x?.length ? { x: normalized.x } : {}),
        ...(!kf?.y?.length ? { y: normalized.y } : {}),
        ...(!kf?.width?.length ? { width: normalized.width } : {}),
        ...(!kf?.height?.length ? { height: normalized.height } : {}),
      },
      editedKeyframe: true,
    };
  }

  return {
    value: {
      ...clip,
      x: normalized.x,
      y: normalized.y,
      width: normalized.width,
      height: normalized.height,
    },
    editedKeyframe: false,
  };
}

/** Update text overlay position at the global playhead. */
export function applyTextOverlayPositionAtPlayhead(
  overlay: TextOverlay,
  pixels: { x: number; y: number },
  canvas: CanvasSize,
  globalTime: number,
): PositionEditResult<TextOverlay> {
  const normalized = textOverlayPixelsToNormalized(pixels, canvas);
  const kf = overlay.keyframes;
  let editedKeyframe = false;
  const nextKeyframes = kf ? { ...kf } : undefined;

  const props: Array<{ prop: TextAnimatableProp; value: number }> = [
    { prop: 'x', value: normalized.x },
    { prop: 'y', value: normalized.y },
  ];

  for (const { prop, value } of props) {
    if (overlay.scrolling && prop === 'x') continue;
    if (kf?.[prop]?.length) {
      editedKeyframe = true;
      nextKeyframes![prop] = upsertKeyframe(
        kf[prop],
        globalTime,
        value,
        KEYFRAME_MERGE_EPSILON,
      );
    }
  }

  if (editedKeyframe && nextKeyframes) {
    return {
      value: {
        ...overlay,
        keyframes: nextKeyframes,
        ...(!kf?.x?.length && !overlay.scrolling ? { x: normalized.x } : {}),
        ...(!kf?.y?.length ? { y: normalized.y } : {}),
      },
      editedKeyframe: true,
    };
  }

  return {
    value: {
      ...overlay,
      ...(!overlay.scrolling ? { x: normalized.x } : {}),
      y: normalized.y,
    },
    editedKeyframe: false,
  };
}
