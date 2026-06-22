import { afterEach, describe, expect, it, vi } from 'vitest';
import { seekVideoTo } from './clipMediaPool';

function makeVideoStub() {
  let currentTime = 0;
  let readyState = 0;
  const listeners = new Map<string, Set<() => void>>();

  const video = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      queueMicrotask(() => {
        readyState = 4;
        listeners.get('seeked')?.forEach((fn) => fn());
      });
    },
    get readyState() {
      return readyState;
    },
    pause: vi.fn(),
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
  } as unknown as HTMLVideoElement;

  return { video, getTime: () => currentTime };
}

describe('seekVideoTo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid seeks on the same element to the latest target', async () => {
    const { video, getTime } = makeVideoStub();

    const first = seekVideoTo(video, 1);
    const second = seekVideoTo(video, 2);
    const third = seekVideoTo(video, 3);

    await Promise.all([first, second, third]);
    expect(getTime()).toBeCloseTo(3);
  });

  it('resolves when the element is already at the target time', async () => {
    const { video } = makeVideoStub();
    video.currentTime = 1.5;
    await expect(seekVideoTo(video, 1.5)).resolves.toBeUndefined();
  });
});
