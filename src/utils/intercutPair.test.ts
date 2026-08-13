import { describe, expect, it } from 'vitest';
import type { Clip, ClipGroup } from '../types';
import { defaultIntercutPair } from './intercutPair';

function makeClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`, { type: 'video/mp4' }),
    objectUrl: `blob:${id}`,
    title: `${id}.mp4`,
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

describe('defaultIntercutPair', () => {
  it('prefers A/B variants from the selected clip group', () => {
    const a = makeClip('a', { groupId: 'g1', groupVariant: 'A' });
    const b = makeClip('b', { groupId: 'g1', groupVariant: 'B' });
    const extra = makeClip('c');
    const group: ClipGroup = {
      id: 'g1',
      variants: { A: a, B: b },
      activeVariant: 'A',
    };
    expect(defaultIntercutPair([a, b, extra], [group], 'b')).toEqual({
      clipAId: 'a',
      clipBId: 'b',
    });
  });

  it('uses selected video plus the next library video', () => {
    const a = makeClip('a');
    const b = makeClip('b');
    const audio = makeClip('bed', { kind: 'audio' });
    expect(defaultIntercutPair([audio, a, b], [], 'b')).toEqual({
      clipAId: 'b',
      clipBId: 'a',
    });
  });
});
