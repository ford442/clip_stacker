import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureStillFrame, releaseStillFrame } from './captureFrame';

let constructed = 0;
const closed: FakeFrame[] = [];

class FakeFrame {
  closedFlag = false;
  constructor(readonly source?: unknown) {
    constructed++;
  }
  clone() {
    if (this.closedFlag) throw new Error('closed');
    return new CloneFrame(this);
  }
  close() {
    this.closedFlag = true;
    closed.push(this);
  }
}

class CloneFrame {
  constructor(readonly of: FakeFrame) {}
  close() {}
}

function stillImage(src = 'blob:still'): HTMLImageElement {
  const img = document.createElement('img');
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: 4 });
  Object.defineProperty(img, 'naturalHeight', { value: 2 });
  img.src = src;
  return img;
}

beforeEach(() => {
  constructed = 0;
  closed.length = 0;
  vi.stubGlobal('VideoFrame', FakeFrame);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('captureStillFrame', () => {
  it('draws a still once and hands out clones', async () => {
    const img = stillImage();
    const a = (await captureStillFrame(img)) as unknown as CloneFrame;
    const b = (await captureStillFrame(img)) as unknown as CloneFrame;
    expect(constructed).toBe(1);
    expect(a).toBeInstanceOf(CloneFrame);
    expect(a.of).toBe(b.of);
  });

  it('redraws when the image source changes, closing the old frame', async () => {
    const img = stillImage('blob:one');
    const first = (await captureStillFrame(img)) as unknown as CloneFrame;
    img.src = 'blob:two';
    const second = (await captureStillFrame(img)) as unknown as CloneFrame;
    expect(constructed).toBe(2);
    expect(second.of).not.toBe(first.of);
    expect(closed).toContain(first.of);
  });

  it('releases the cached frame', async () => {
    const img = stillImage();
    const frame = (await captureStillFrame(img)) as unknown as CloneFrame;
    releaseStillFrame(img);
    expect(frame.of.closedFlag).toBe(true);
    await captureStillFrame(img);
    expect(constructed).toBe(2);
  });

  it('returns null before the image has decoded', async () => {
    const img = document.createElement('img');
    expect(await captureStillFrame(img)).toBeNull();
  });
});
