import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetPlaybackStoreForTests, setPlayheadTime } from '../store/playbackStore';
import { act, renderHook, type RenderedHook } from './renderHook.test.helpers';
import { useHeldPlayheadTime } from './usePlayheadTime';

describe('useHeldPlayheadTime', () => {
  let hook: RenderedHook<number> | null = null;

  beforeEach(() => __resetPlaybackStoreForTests());
  afterEach(() => {
    hook?.unmount();
    hook = null;
  });

  it('is 0 before the playhead is ever placed', () => {
    hook = renderHook(useHeldPlayheadTime);
    expect(hook.current).toBe(0);
  });

  it('follows the playhead and holds its last time while it is cleared', () => {
    setPlayheadTime(2);
    hook = renderHook(useHeldPlayheadTime);
    expect(hook.current).toBe(2);
    act(() => setPlayheadTime(3.5));
    expect(hook.current).toBe(3.5);
    act(() => setPlayheadTime(null));
    expect(hook.current).toBe(3.5);
    act(() => setPlayheadTime(1));
    expect(hook.current).toBe(1);
  });
});
