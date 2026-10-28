import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import {
  clipHasLayoutKeyframes,
  clipHasPictureTransform,
  createKenBurnsKeyframes,
  resolveAnimatedClipLayout,
  resolveAnimatedPictureTransform,
  resolveAnimatedTextLayout,
  setPictureTransformValue,
} from './animatedLayout';
import { IDENTITY_PICTURE_TRANSFORM } from './clipTransform';

describe('animatedLayout', () => {
  it('interpolates PiP position over local time', () => {
    const clip: Clip = {
      id: 'pip',
      file: new File([], 'pip.mp4'),
      objectUrl: 'blob:pip',
      title: 'pip',
      kind: 'video',
      duration: 5,
      trimStart: 0,
      trimEnd: NaN,
      videoFadeIn: 0,
      videoFadeOut: 0,
      audioFadeIn: 0,
      audioFadeOut: 0,
      layerIndex: 1,
      x: 0,
      y: 0,
      width: 200 / 1280,
      height: 100 / 720,
      opacity: 1,
      keyframes: {
        x: [
          { t: 0, value: 0 },
          { t: 2, value: 100 / 1280 },
        ],
      },
    };

    const start = resolveAnimatedClipLayout(clip, 0, 1280, 720, 1);
    const mid = resolveAnimatedClipLayout(clip, 1, 1280, 720, 1);
    expect(start.x).toBe(0);
    expect(mid.x).toBe(50);
  });

  it('animates text x at global time', () => {
    const layout = resolveAnimatedTextLayout(
      {
        id: 't1',
        text: 'Hi',
        fontsize: 24,
        fontcolor: '#fff',
        x: 0,
        y: 100 / 720,
        scrolling: false,
        scrollSpeed: 20,
        box: false,
        boxColor: 'black@0.5',
        keyframes: {
          x: [
            { t: 0, value: 0 },
            { t: 10, value: 200 / 1280 },
          ],
        },
      },
      5,
      10,
      1280,
      720,
      1,
    );
    expect(layout.x).toBe(100);
    expect(layout.opacity).toBe(1);
  });

  it('creates Ken Burns UV keyframes spanning clip duration', () => {
    const kf = createKenBurnsKeyframes(4);
    expect(kf.uvScaleX?.[1].value).toBeLessThan(1);
    expect(kf.uvOffsetX?.[1].t).toBe(4);
  });
});

describe('picture transform lanes', () => {
  it('is identity with no lanes (old projects do not move)', () => {
    expect(resolveAnimatedPictureTransform({}, 3)).toBe(IDENTITY_PICTURE_TRANSFORM);
    expect(clipHasPictureTransform({})).toBe(false);
  });

  it('samples rotation in degrees and returns radians', () => {
    const t = resolveAnimatedPictureTransform(
      { keyframes: { rotation: [{ t: 0, value: 0 }, { t: 2, value: 180 }] } },
      1,
    );
    expect(t.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(t.scaleX).toBe(1);
    expect(t.anchorX).toBe(0.5);
  });

  it('does not count transform lanes as layout lanes', () => {
    const clip = { keyframes: { rotation: [{ t: 0, value: 10 }] } };
    expect(clipHasPictureTransform(clip)).toBe(true);
    expect(clipHasLayoutKeyframes(clip)).toBe(false);
    expect(clipHasLayoutKeyframes({ keyframes: { ...clip.keyframes, x: [{ t: 0, value: 0.1 }] } })).toBe(true);
  });

  it('sets a static value, and drops the lane when it goes back to the default', () => {
    const set = setPictureTransformValue(undefined, 'scaleX', 2, 1.5);
    expect(set).toEqual({ scaleX: [{ t: 0, value: 2 }] });
    expect(setPictureTransformValue(set, 'scaleX', 1, 1.5)).toBeUndefined();
  });

  it('keys an animated lane at the playhead instead of flattening it', () => {
    const animated = { rotation: [{ t: 0, value: 0 }, { t: 2, value: 90 }] };
    expect(setPictureTransformValue(animated, 'rotation', 45, 1)).toEqual({
      rotation: [
        { t: 0, value: 0 },
        { t: 1, value: 45 },
        { t: 2, value: 90 },
      ],
    });
  });
});
