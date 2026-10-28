import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYHEAD_EPSILON_SEC,
  __resetPlaybackStoreForTests,
  playbackStore,
  setPlayheadTime,
} from './playbackStore';

describe('playbackStore', () => {
  beforeEach(() => {
    __resetPlaybackStoreForTests();
  });

  it('stores playhead time', () => {
    setPlayheadTime(1.25);
    expect(playbackStore.getState().playheadTime).toBe(1.25);
  });

  it('clears playhead to null', () => {
    setPlayheadTime(2);
    setPlayheadTime(null);
    expect(playbackStore.getState().playheadTime).toBeNull();
  });

  it('does not notify subscribers for identical values', () => {
    setPlayheadTime(3);
    const listener = vi.fn();
    const unsub = playbackStore.subscribe(listener);
    setPlayheadTime(3);
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('does not notify subscribers for sub-epsilon float noise', () => {
    setPlayheadTime(5);
    const listener = vi.fn();
    const unsub = playbackStore.subscribe(listener);
    setPlayheadTime(5 + PLAYHEAD_EPSILON_SEC / 2);
    expect(listener).not.toHaveBeenCalled();
    expect(playbackStore.getState().playheadTime).toBe(5);
    unsub();
  });

  it('notifies when playhead moves beyond epsilon', () => {
    setPlayheadTime(5);
    const listener = vi.fn();
    const unsub = playbackStore.subscribe(listener);
    setPlayheadTime(5 + PLAYHEAD_EPSILON_SEC * 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(playbackStore.getState().playheadTime).toBe(5 + PLAYHEAD_EPSILON_SEC * 2);
    unsub();
  });
});

describe('playbackStore scrubbing', () => {
  beforeEach(() => {
    __resetPlaybackStoreForTests();
  });

  it('toggles scrubbing and only notifies on change', () => {
    const listener = vi.fn();
    const unsub = playbackStore.subscribe(listener);
    playbackStore.getState().setScrubbing(true);
    playbackStore.getState().setScrubbing(true);
    expect(playbackStore.getState().scrubbing).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    playbackStore.getState().setScrubbing(false);
    expect(playbackStore.getState().scrubbing).toBe(false);
    unsub();
  });
});
