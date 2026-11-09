import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAndClose, waitForQueueBelow, type QueuedCodec } from './codecQueue';

/** A minimal encoder double: an EventTarget with a queue size and a state. */
function fakeEncoder(size: number) {
  const target = new EventTarget() as EventTarget & {
    encodeQueueSize: number;
    state: CodecState;
    encode: ReturnType<typeof vi.fn>;
  };
  target.encodeQueueSize = size;
  target.state = 'configured';
  target.encode = vi.fn();
  return target;
}

describe('waitForQueueBelow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the queue is already below the limit', async () => {
    const codec = fakeEncoder(2);
    await expect(waitForQueueBelow(codec as unknown as QueuedCodec, 3)).resolves.toBeUndefined();
  });

  it('resolves on the dequeue that takes the queue below the limit', async () => {
    const codec = fakeEncoder(5);
    let settled = false;
    const wait = waitForQueueBelow(codec as unknown as QueuedCodec, 4).then(() => {
      settled = true;
    });
    codec.encodeQueueSize = 4;
    codec.dispatchEvent(new Event('dequeue'));
    await Promise.resolve();
    expect(settled).toBe(false);
    codec.encodeQueueSize = 3;
    codec.dispatchEvent(new Event('dequeue'));
    await wait;
    expect(settled).toBe(true);
  });

  it('rejects when the codec closes (error) without another dequeue', async () => {
    const codec = fakeEncoder(10);
    const wait = waitForQueueBelow(codec as unknown as QueuedCodec, 4);
    codec.state = 'closed';
    vi.advanceTimersByTime(100);
    await expect(wait).rejects.toThrow(/closed/);
  });

  it('rejects a codec that is already closed', async () => {
    const codec = fakeEncoder(0);
    codec.state = 'closed';
    await expect(waitForQueueBelow(codec as unknown as QueuedCodec, 4)).rejects.toThrow(/closed/);
  });

  it('rejects when the queue does not drain before the timeout', async () => {
    const codec = fakeEncoder(10);
    const wait = waitForQueueBelow(codec as unknown as QueuedCodec, 4, { timeoutMs: 500 });
    const assertion = expect(wait).rejects.toThrow(/did not drain within 500 ms/);
    vi.advanceTimersByTime(600);
    await assertion;
  });

  it('works for decoders (decodeQueueSize)', async () => {
    const codec = Object.assign(new EventTarget(), { decodeQueueSize: 20, state: 'configured' });
    const wait = waitForQueueBelow(codec as unknown as QueuedCodec, 17);
    codec.decodeQueueSize = 16;
    vi.advanceTimersByTime(60);
    await expect(wait).resolves.toBeUndefined();
  });
});

describe('encodeAndClose', () => {
  it('closes the frame when encode() throws', () => {
    const encoder = fakeEncoder(0);
    encoder.encode.mockImplementation(() => {
      throw new DOMException('Encoder is closed', 'InvalidStateError');
    });
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    expect(() => encodeAndClose(encoder as unknown as VideoEncoder, frame)).toThrow(/closed/);
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it('closes the frame after a successful encode', () => {
    const encoder = fakeEncoder(0);
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    encodeAndClose(encoder as unknown as VideoEncoder, frame, { keyFrame: true });
    expect(encoder.encode).toHaveBeenCalledWith(frame, { keyFrame: true });
    expect(frame.close).toHaveBeenCalledTimes(1);
  });
});
