import { describe, expect, it } from 'vitest';
import { orphanTransitionIndices } from './timelineMediaCache';

describe('orphanTransitionIndices', () => {
  it('returns transition indices visible only via the left neighbor', () => {
    const visible = new Set([2, 5]);
    const hasTransition = (index: number) => index === 3 || index === 6;

    expect(orphanTransitionIndices(visible, 8, hasTransition)).toEqual([3, 6]);
  });

  it('skips indices when the right clip is also visible', () => {
    const visible = new Set([2, 3]);
    const hasTransition = (index: number) => index === 3;

    expect(orphanTransitionIndices(visible, 5, hasTransition)).toEqual([]);
  });
});
