import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { buildBeatMarkerLayouts, beatsInTrimWindow } from './beatMarkers';
import type { VirtualClipLayout } from '../components/timelineClipTypes';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File([], 'a.mp4'),
    objectUrl: 'blob:x',
    title: 'a',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('beatMarkers', () => {
  it('maps beats into trimmed window only', () => {
    const clip = makeClip({
      trimStart: 1,
      trimEnd: 5,
      beatTimestamps: [0.5, 1.5, 3, 6],
    });
    expect(beatsInTrimWindow(clip)).toEqual([1.5, 3]);
  });

  it('places markers in pixel space', () => {
    const clip = makeClip({
      duration: 4,
      trimStart: 0,
      trimEnd: 4,
      beatTimestamps: [0, 2, 4],
    });
    const layouts: VirtualClipLayout[] = [
      { clip, index: 0, duration: 4, width: 400, start: 100 },
    ];
    const markers = buildBeatMarkerLayouts(layouts);
    expect(markers.map((m) => m.leftPx)).toEqual([100, 300, 500]);
  });
});
