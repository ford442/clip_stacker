import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCanvasCapture } from './media-recorder-encoder';

type MockRecorder = {
  state: RecordingState;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function createMockRecorder(): MockRecorder {
  return {
    state: 'recording',
    ondataavailable: null,
    onerror: null,
    onstop: null,
    start: vi.fn(),
    stop: vi.fn(function stop(this: MockRecorder) {
      this.state = 'inactive';
    }),
  };
}

describe('startCanvasCapture', () => {
  let mockRecorder: MockRecorder;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    mockRecorder = createMockRecorder();
    canvas = document.createElement('canvas');
    canvas.captureStream = vi.fn(() => ({
      getTracks: () => [{ stop: vi.fn() }],
    })) as unknown as HTMLCanvasElement['captureStream'];

    class MockMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      ondataavailable: MockRecorder['ondataavailable'] = null;
      onerror: MockRecorder['onerror'] = null;
      onstop: MockRecorder['onstop'] = null;
      state: RecordingState = 'recording';

      constructor() {
        return mockRecorder as unknown as MockMediaRecorder;
      }

      start = mockRecorder.start;
      stop = mockRecorder.stop;
    }

    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rejects onFailure when MediaRecorder errors during recording', async () => {
    const handle = startCanvasCapture(canvas);
    const failure = handle.onFailure();

    const domError = new DOMException('encoder failed', 'EncodingError');
    mockRecorder.onerror?.({ error: domError } as Event & { error: DOMException });

    await expect(failure).rejects.toThrow(
      'MediaRecorder error (onerror): encoder failed',
    );
    await expect(handle.stop()).rejects.toThrow(
      'MediaRecorder error (onerror): encoder failed',
    );
  });

  it('rejects stop with onerror details when failure happens during stop', async () => {
    const handle = startCanvasCapture(canvas);

    mockRecorder.stop = vi.fn(function stop(this: MockRecorder) {
      this.state = 'inactive';
      const domError = new DOMException('flush failed', 'InvalidStateError');
      this.onerror?.({ error: domError } as Event & { error: DOMException });
    });

    await expect(handle.stop()).rejects.toThrow(
      'MediaRecorder error (onerror during stop): flush failed',
    );
  });

  it('resolves stop with assembled chunks when recording completes', async () => {
    const handle = startCanvasCapture(canvas);
    const chunk = new Blob(['video'], { type: 'video/webm' });

    mockRecorder.stop = vi.fn(function stop(this: MockRecorder) {
      this.state = 'inactive';
      this.ondataavailable?.({ data: chunk } as BlobEvent);
      this.onstop?.();
    });

    const blob = await handle.stop();
    expect(blob.size).toBeGreaterThan(0);
  });

  it('rejects stop when onstop never fires within the timeout', async () => {
    vi.useFakeTimers();
    const handle = startCanvasCapture(canvas, { stopTimeoutMs: 1000 });

    const stopPromise = handle.stop();
    const expectation = expect(stopPromise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });
});
