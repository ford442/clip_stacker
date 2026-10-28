import { describe, expect, it } from 'vitest';
import { reverseChannelWindow } from './reverseClip';
import { reverseChunkBounds } from './reverseFrames';

describe('reverseChannelWindow', () => {
  it('reverses the trim window and leaves samples outside it unread', () => {
    const samples = Float32Array.from([0, 1, 2, 3, 4, 5]);
    expect(Array.from(reverseChannelWindow(samples, 1, 5))).toEqual([4, 3, 2, 1]);
  });
});

describe('reverseChunkBounds', () => {
  it('covers a short trim in one chunk', () => {
    expect(reverseChunkBounds(0, 0.4, 0.2)).toEqual({ start: 0, end: 0.4 });
  });

  it('aligns chunks to the trim end so reverse playback starts in the last chunk', () => {
    expect(reverseChunkBounds(0, 10, 9.5)).toEqual({ start: 9, end: 10 });
    expect(reverseChunkBounds(0, 10, 8.2)).toEqual({ start: 8, end: 9 });
    expect(reverseChunkBounds(0, 10, 0)).toEqual({ start: 0, end: 1 });
  });
});
