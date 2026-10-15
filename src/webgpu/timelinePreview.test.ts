import { describe, it, expect } from 'vitest';
import { toNormalizedDestRect } from './timelinePreview';

describe('timelinePreview', () => {
  it('normalizes PiP destination rects for shader uniforms', () => {
    expect(
      toNormalizedDestRect({ x: 128, y: 72, width: 320, height: 180 }, 1280, 720),
    ).toEqual({ x: 0.1, y: 0.1, w: 0.25, h: 0.25 });
  });
});
