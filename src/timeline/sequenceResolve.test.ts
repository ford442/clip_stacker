import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  nestedInstanceId,
  sanitizeSequenceClip,
  sequenceReferences,
  sequenceWouldCycle,
  sequencesReachableFrom,
} from './sequenceResolve';
import { createSequenceClip } from './sequenceModel';
import { seqTestClip } from './sequences.test.helpers';

const playing = (id: string, sequenceId: string): Clip => createSequenceClip({ id: sequenceId, name: sequenceId }, 4, id);

describe('sequenceResolve', () => {
  it('namespaces instance ids without the decoder key separator', () => {
    expect(nestedInstanceId('S', 'b')).toBe('S>b');
    expect(nestedInstanceId(nestedInstanceId('S', 'T'), 'b')).toBe('S>T>b');
  });

  it('finds every sequence reachable from one and detects cycles', () => {
    const sequences = [
      { id: 'A', clips: [playing('a1', 'B')] },
      { id: 'B', clips: [playing('b1', 'C'), seqTestClip('media', 2)] },
      { id: 'C', clips: [] as Clip[] },
    ];
    expect(sequenceReferences(sequences[1]!)).toEqual(['C']);
    expect([...sequencesReachableFrom(sequences, 'A')].sort()).toEqual(['A', 'B', 'C']);
    // Placing A inside C: C → A → B → C.
    expect(sequenceWouldCycle(sequences, 'C', 'A')).toBe(true);
    expect(sequenceWouldCycle(sequences, 'A', 'A')).toBe(true);
    expect(sequenceWouldCycle(sequences, 'A', 'C')).toBe(false);
    // The root is never inside a sequence.
    expect(sequenceWouldCycle(sequences, null, 'A')).toBe(false);
  });

  it('strips what a sequence clip cannot honour and keeps what it can', () => {
    const clip: Clip = {
      ...playing('s', 'X'),
      playbackRate: 2,
      reversed: true,
      loopCount: 3,
      stabilize: true,
      chromaKey: { color: '#00ff00', similarity: 0.4, blend: 0.1 },
      automation: { playbackRate: [{ t: 0, value: 1 }], volume: [{ t: 0, value: 0.5 }] },
      keyframes: { rotation: [{ t: 0, value: 10 }], opacity: [{ t: 0, value: 0.5 }] },
      opacity: 0.7,
      videoFadeIn: 1,
    };
    const clean = sanitizeSequenceClip(clip);
    expect(clean.playbackRate).toBeUndefined();
    expect(clean.reversed).toBeUndefined();
    expect(clean.loopCount).toBeUndefined();
    expect(clean.stabilize).toBeUndefined();
    expect(clean.chromaKey).toBeUndefined();
    expect(clean.automation).toEqual({ volume: [{ t: 0, value: 0.5 }] });
    expect(clean.keyframes).toEqual({ opacity: [{ t: 0, value: 0.5 }] });
    expect(clean.opacity).toBe(0.7);
    expect(clean.videoFadeIn).toBe(1);

    const plain = playing('p', 'X');
    expect(sanitizeSequenceClip(plain)).toBe(plain);
    const media = seqTestClip('m', 2, { playbackRate: 2 });
    expect(sanitizeSequenceClip(media)).toBe(media);
  });
});
