import { afterEach, describe, expect, it, vi } from 'vitest';
import { seekToFrame } from './videoFrameCapture';

interface StubOptions {
  withRvfc?: boolean;
  startTime?: number;
  startReadyState?: number;
}

/**
 * Minimal HTMLVideoElement stub. Setting `currentTime` asynchronously bumps
 * readyState, fires `seeked`, and (when enabled) invokes the pending
 * requestVideoFrameCallback — mirroring how a real element presents a frame
 * after a seek.
 */
function makeVideoStub({ withRvfc = true, startTime = 0, startReadyState = 0 }: StubOptions = {}) {
  let currentTime = startTime;
  let readyState = startReadyState;
  let pendingRvfc: (() => void) | null = null;
  const listeners = new Map<string, Set<() => void>>();

  const video = {
    seeking: false,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      queueMicrotask(() => {
        readyState = 4;
        listeners.get('seeked')?.forEach((fn) => fn());
        if (pendingRvfc) {
          const cb = pendingRvfc;
          pendingRvfc = null;
          cb();
        }
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
    ...(withRvfc
      ? {
          requestVideoFrameCallback(cb: () => void) {
            pendingRvfc = cb;
            return 1;
          },
          cancelVideoFrameCallback() {
            pendingRvfc = null;
          },
        }
      : {}),
  } as unknown as HTMLVideoElement;

  return { video, getTime: () => currentTime };
}

describe('seekToFrame', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves true once a presented frame arrives via requestVideoFrameCallback', async () => {
    const { video, getTime } = makeVideoStub({ withRvfc: true });
    await expect(seekToFrame(video, 2)).resolves.toBe(true);
    expect(getTime()).toBeCloseTo(2);
  });

  it('falls back to the seeked event when rVFC is unavailable', async () => {
    const { video, getTime } = makeVideoStub({ withRvfc: false });
    await expect(seekToFrame(video, 1.5)).resolves.toBe(true);
    expect(getTime()).toBeCloseTo(1.5);
  });

  it('resolves immediately when already parked on the target frame', async () => {
    const { video } = makeVideoStub({ startTime: 3, startReadyState: 4 });
    await expect(seekToFrame(video, 3)).resolves.toBe(true);
    expect(video.pause).not.toHaveBeenCalled();
  });
});
