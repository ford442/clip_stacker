import { describe, it, expect, vi } from 'vitest';
import { FrameCursor, type SequentialFrame } from './decoderCursor';

/** Fake sequential frame: timestamp/duration in microseconds, tracks close()/clone() calls. */
class FakeFrame implements SequentialFrame {
  closed = false;
  constructor(
    public timestamp: number,
    public duration: number,
    private readonly onClose?: (frame: FakeFrame) => void,
  ) {}
  close(): void {
    this.closed = true;
    this.onClose?.(this);
  }
  clone(): FakeFrame {
    return new FakeFrame(this.timestamp, this.duration, this.onClose);
  }
}

/** 30fps stream of frames at 0, 1/30, 2/30, ... seconds (as microsecond timestamps). */
function makeFrameSource(count: number, fps = 30, onClose?: (frame: FakeFrame) => void): AsyncIterator<FakeFrame> {
  const frameDuration = Math.round(1_000_000 / fps);
  const frames = Array.from(
    { length: count },
    (_, i) => new FakeFrame(Math.round((i / fps) * 1_000_000), frameDuration, onClose),
  );
  let index = 0;
  return {
    async next() {
      if (index >= frames.length) return { value: undefined, done: true };
      return { value: frames[index++], done: false };
    },
  };
}

describe('FrameCursor', () => {
  it('returns the first frame for a request at or after time 0', async () => {
    const cursor = new FrameCursor(makeFrameSource(5));
    const frame = await cursor.frameAt(0);
    expect(frame?.timestamp).toBe(0);
  });

  it('holds the current frame until the next frame timestamp is reached', async () => {
    const cursor = new FrameCursor(makeFrameSource(5));
    // Frame 0 spans [0, 1/30); requesting mid-window should still return frame 0.
    const frame = await cursor.frameAt(1 / 60);
    expect(frame?.timestamp).toBe(0);
  });

  it('advances forward as requested time increases, never re-serving a stale frame', async () => {
    const cursor = new FrameCursor(makeFrameSource(5));
    // Request just past each frame's own timestamp — comfortably inside its
    // window and unambiguously past the previous frame's, avoiding exact
    // floating-point equality with a rounded-microsecond boundary.
    const expectedTimestamps = [0, 1, 2, 3, 4].map((i) => Math.round((i / 30) * 1_000_000));
    const times = expectedTimestamps.map((ts) => (ts + 1) / 1_000_000);
    const seen: number[] = [];
    for (const t of times) {
      const frame = await cursor.frameAt(t);
      seen.push(frame!.timestamp);
    }
    expect(seen).toEqual(expectedTimestamps);
  });

  it('closes frames it steps past exactly once', async () => {
    const closed: number[] = [];
    const frameDuration = Math.round(1_000_000 / 30);
    const cursor = new FrameCursor(makeFrameSource(3, 30, (f) => closed.push(f.timestamp)));
    await cursor.frameAt(0);
    await cursor.frameAt((frameDuration + 1) / 1_000_000); // steps past frame 0
    await cursor.frameAt((2 * frameDuration + 1) / 1_000_000); // steps past frame 1
    expect(closed).toEqual([0, frameDuration]);
  });

  it('returns clones so the caller can close its copy independently', async () => {
    const cursor = new FrameCursor(makeFrameSource(2));
    const frame = await cursor.frameAt(0);
    frame!.close();
    // Cursor's internal copy is unaffected — asking again still works.
    const again = await cursor.frameAt(0);
    expect(again?.closed).toBe(false);
  });

  it('returns null once the source is exhausted', async () => {
    const cursor = new FrameCursor(makeFrameSource(2)); // frames at 0, 1/30
    await cursor.frameAt(0);
    await cursor.frameAt(1 / 30);
    const frame = await cursor.frameAt(10); // well past the last frame
    expect(frame).toBeNull();
  });

  it('close() releases the held frame and further requests return null', async () => {
    const onClose = vi.fn();
    const cursor = new FrameCursor(makeFrameSource(3, 30, onClose));
    await cursor.frameAt(0);
    cursor.close();
    expect(onClose).toHaveBeenCalled();
    const frame = await cursor.frameAt(0);
    expect(frame).toBeNull();
  });
});
