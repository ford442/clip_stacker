import { describe, it, expect } from 'vitest';
import type { Clip, ClipTransition } from '../types';
import {
  MORPH_SEGMENT_FPS,
  MORPH_TRANSITION_TYPE,
  morphClipId,
  morphFrameCountForDuration,
  shouldRegenerateMorph,
  getMorphNeighborClips,
  formatMorphFailureMessage,
} from './morphTransition';
import { buildPreviewCompositionPlan } from './previewComposition';

function makeClip(id: string, duration = 5): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('morphTransition', () => {
  it('computes frame count from transition duration', () => {
    expect(morphFrameCountForDuration(0.5)).toBe(15);
    expect(morphFrameCountForDuration(0.5)).toBe(
      Math.round(0.5 * MORPH_SEGMENT_FPS),
    );
  });

  it('requires regeneration when morph type or duration changes', () => {
    const base: ClipTransition = {
      afterClipIndex: 1,
      type: MORPH_TRANSITION_TYPE,
      duration: 0.5,
    };
    expect(shouldRegenerateMorph(undefined, base)).toBe(true);
    expect(
      shouldRegenerateMorph(base, { ...base, duration: 0.8 }),
    ).toBe(true);
    expect(
      shouldRegenerateMorph(base, {
        ...base,
        morphSegment: {
          objectUrl: 'blob:m',
          fileName: 'm.mp4',
          duration: 0.5,
          status: 'ready',
        },
      }),
    ).toBe(false);
  });

  it('resolves adjacent video clips for morph generation', () => {
    const clips = [makeClip('a'), makeClip('b')];
    const transition: ClipTransition = {
      afterClipIndex: 1,
      type: MORPH_TRANSITION_TYPE,
      duration: 0.5,
    };
    const neighbors = getMorphNeighborClips(transition, clips);
    expect(neighbors?.clipA.id).toBe('a');
    expect(neighbors?.clipB.id).toBe('b');
  });

  it('formats cold-start failures with a dissolve fallback hint', () => {
    expect(
      formatMorphFailureMessage(new Error('Space call failed (HTTP 503)')),
    ).toMatch(/dissolve/i);
  });
});

describe('previewComposition morph layers', () => {
  it('plays the morph segment during the overlap window', () => {
    const clips = [makeClip('a', 5), makeClip('b', 5)];
    const transitions: ClipTransition[] = [
      {
        afterClipIndex: 1,
        type: MORPH_TRANSITION_TYPE,
        duration: 1,
        morphSegment: {
          objectUrl: 'blob:morph-segment',
          fileName: 'morph.mp4',
          duration: 1,
          status: 'ready',
        },
      },
    ];

    // Overlap starts at t=4 (5 - 1).
    const plan = buildPreviewCompositionPlan(clips, [], transitions, [], undefined, 4.5);
    const morphLayer = plan.layers.find(
      (layer) => layer.kind !== 'text' && layer.clipId === morphClipId(1),
    );
    expect(morphLayer).toBeDefined();
    expect(morphLayer && 'mediaObjectUrl' in morphLayer && morphLayer.mediaObjectUrl).toBe(
      'blob:morph-segment',
    );
    expect(morphLayer && 'localElapsed' in morphLayer && morphLayer.localElapsed).toBeCloseTo(
      0.5,
    );
  });
});
