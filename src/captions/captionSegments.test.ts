import { describe, expect, it } from 'vitest';
import { mergeCaptions, segmentsToCaptions } from './captionSegments';
import { MIN_CAPTION_DURATION_SEC } from './subtitles';
import type { CaptionEntry } from '../types';

const ids = () => {
  let n = 0;
  return () => `cue-${++n}`;
};

describe('segmentsToCaptions', () => {
  it('maps segments to cues with generated ids, sorted by start time', () => {
    const cues = segmentsToCaptions(
      [
        { startSec: 2, endSec: 3, text: ' second ' },
        { startSec: 0, endSec: 1.5, text: 'first' },
      ],
      { createId: ids() },
    );
    expect(cues).toEqual([
      { id: 'cue-2', startSec: 0, endSec: 1.5, text: 'first' },
      { id: 'cue-1', startSec: 2, endSec: 3, text: 'second' },
    ]);
  });

  it('offsets every cue onto the output timeline', () => {
    const [cue] = segmentsToCaptions([{ startSec: 1, endSec: 2, text: 'hi' }], {
      timeOffsetSec: 10,
      createId: ids(),
    });
    expect(cue.startSec).toBe(11);
    expect(cue.endSec).toBe(12);
  });

  it('never emits a negative start after offsetting', () => {
    const [cue] = segmentsToCaptions([{ startSec: 1, endSec: 2, text: 'hi' }], {
      timeOffsetSec: -5,
      createId: ids(),
    });
    expect(cue.startSec).toBe(0);
  });

  it('enforces a minimum cue duration', () => {
    const [cue] = segmentsToCaptions([{ startSec: 4, endSec: 4, text: 'blip' }], {
      createId: ids(),
    });
    expect(cue.endSec).toBeCloseTo(4 + MIN_CAPTION_DURATION_SEC, 6);
  });

  it('drops blank cues, non-speech markers and non-finite timings', () => {
    const cues = segmentsToCaptions(
      [
        { startSec: 0, endSec: 1, text: '   ' },
        { startSec: 1, endSec: 2, text: '[BLANK_AUDIO]' },
        { startSec: 2, endSec: 3, text: '(music)' },
        { startSec: Number.NaN, endSec: 4, text: 'lost' },
        { startSec: 4, endSec: Number.POSITIVE_INFINITY, text: 'also lost' },
        { startSec: 5, endSec: 6, text: 'kept' },
      ],
      { createId: ids() },
    );
    expect(cues.map((c) => c.text)).toEqual(['kept']);
  });

  it('collapses runs of spaces but keeps line breaks', () => {
    const [cue] = segmentsToCaptions(
      [{ startSec: 0, endSec: 1, text: '  hello   there \n  second line  ' }],
      { createId: ids() },
    );
    expect(cue.text).toBe('hello there\nsecond line');
  });
});

describe('mergeCaptions', () => {
  const existing: CaptionEntry[] = [
    { id: 'a', startSec: 0, endSec: 2, text: 'hand written' },
  ];

  it('keeps existing cues and adds non-overlapping new ones', () => {
    const merged = mergeCaptions(existing, [
      { id: 'b', startSec: 3, endSec: 4, text: 'new' },
    ]);
    expect(merged.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('drops incoming cues that overlap an existing one', () => {
    const merged = mergeCaptions(existing, [
      { id: 'b', startSec: 1, endSec: 3, text: 'overlaps' },
      { id: 'c', startSec: 2, endSec: 3, text: 'abuts, kept' },
    ]);
    expect(merged.map((c) => c.id)).toEqual(['a', 'c']);
  });
});
