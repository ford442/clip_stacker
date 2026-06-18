import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import { shouldUseTimelinePreview, toNormalizedDestRect } from './timelinePreview';

function makeClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('timelinePreview', () => {
  it('enables timeline preview for multi-clip stacks and PiP overlays', () => {
    expect(shouldUseTimelinePreview([])).toBe(false);
    expect(shouldUseTimelinePreview([makeClip('a')])).toBe(false);
    expect(shouldUseTimelinePreview([makeClip('a'), makeClip('b')])).toBe(true);
    expect(
      shouldUseTimelinePreview([
        makeClip('a'),
        makeClip('pip', { layerIndex: 1 }),
      ]),
    ).toBe(true);
    expect(shouldUseTimelinePreview([makeClip('audio', { kind: 'audio' })])).toBe(
      false,
    );
  });

  it('normalizes PiP destination rects for shader uniforms', () => {
    expect(
      toNormalizedDestRect({ x: 128, y: 72, width: 320, height: 180 }, 1280, 720),
    ).toEqual({ x: 0.1, y: 0.1, w: 0.25, h: 0.25 });
  });
});
