import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { duplicateClip, splitClipAt } from './clipOperations';
import { MIN_CLIP_DURATION } from './media';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
  return {
    id: 'clip-1',
    file,
    objectUrl: 'blob:clip-1',
    title: 'Scene',
    kind: 'video',
    duration: 10,
    trimStart: 1,
    trimEnd: 9,
    videoFadeIn: 0.5,
    videoFadeOut: 0.25,
    audioFadeIn: 0.3,
    audioFadeOut: 0.2,
    layerIndex: 1,
    x: 40,
    y: 60,
    width: 320,
    height: 180,
    opacity: 0.8,
    volume: 1.2,
    groupId: 'group-1',
    groupVariant: 'A',
    ...overrides,
  };
}

describe('clipOperations', () => {
  it('duplicateClip copies editable properties with a new id', () => {
    const source = makeClip();
    const copy = duplicateClip(source);

    expect(copy.id).not.toBe(source.id);
    expect(copy.file).toBe(source.file);
    expect(copy.objectUrl).toBe(source.objectUrl);
    expect(copy.trimStart).toBe(1);
    expect(copy.trimEnd).toBe(9);
    expect(copy.videoFadeIn).toBe(0.5);
    expect(copy.videoFadeOut).toBe(0.25);
    expect(copy.audioFadeIn).toBe(0.3);
    expect(copy.audioFadeOut).toBe(0.2);
    expect(copy.layerIndex).toBe(1);
    expect(copy.x).toBe(40);
    expect(copy.y).toBe(60);
    expect(copy.width).toBe(320);
    expect(copy.height).toBe(180);
    expect(copy.opacity).toBe(0.8);
    expect(copy.volume).toBe(1.2);
    expect(copy.groupId).toBeUndefined();
    expect(copy.groupVariant).toBeUndefined();
    expect(copy.title).toContain('(copy)');
  });

  it('splitClipAt creates two clips with adjusted trim points', () => {
    const source = makeClip();
    const result = splitClipAt(source, 5);

    expect(result).not.toBeNull();
    const [left, right] = result!;

    expect(left.id).toBe(source.id);
    expect(left.trimStart).toBe(1);
    expect(left.trimEnd).toBe(5);
    expect(left.videoFadeIn).toBe(0.5);

    expect(right.id).not.toBe(source.id);
    expect(right.trimStart).toBe(5);
    expect(right.trimEnd).toBe(9);
    expect(right.videoFadeOut).toBe(0.25);
    expect(right.file).toBe(source.file);
    expect(right.objectUrl).toBe(source.objectUrl);
    expect(right.groupId).toBeUndefined();
  });

  it('splitClipAt rejects splits too close to trim edges', () => {
    const source = makeClip({ trimStart: 0, trimEnd: 1 });
    expect(splitClipAt(source, 0)).toBeNull();
    expect(splitClipAt(source, 1)).toBeNull();
    expect(splitClipAt(source, MIN_CLIP_DURATION / 2)).toBeNull();
  });
});
