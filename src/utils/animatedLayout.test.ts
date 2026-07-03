import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import {
  createKenBurnsKeyframes,
  resolveAnimatedClipLayout,
  resolveAnimatedTextLayout,
} from './animatedLayout';

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
      width: 200,
      height: 100,
      opacity: 1,
      keyframes: {
        x: [
          { t: 0, value: 0 },
          { t: 2, value: 100 },
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
        y: 100,
        scrolling: false,
        scrollSpeed: 20,
        box: false,
        boxColor: 'black@0.5',
        keyframes: {
          x: [
            { t: 0, value: 0 },
            { t: 10, value: 200 },
          ],
        },
      },
      5,
      10,
      1280,
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
