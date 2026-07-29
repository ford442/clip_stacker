import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Clip } from '../types';
import type { PreviewClipLayer } from './previewComposition';

const openMock = vi.fn();
vi.mock('./decoderCursor', () => ({
  DecoderFrameCursor: { open: (...args: unknown[]) => openMock(...args) },
}));

// Imported after the mock so the module under test picks up the mocked cursor.
const { TimelineDecoderFrameProvider } = await import('./decoderFrameProvider');

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    file: new File([], 'clip-1.mp4'),
    objectUrl: 'blob:clip-1',
    title: 'Clip 1',
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

function makeLayer(overrides: Partial<PreviewClipLayer> = {}): PreviewClipLayer {
  return {
    kind: 'base',
    clipId: 'clip-1',
    timelineIndex: 0,
    zIndex: 0,
    localElapsed: 0,
    clipDuration: 5,
    sourceTime: 0,
    opacity: 1,
    rect: { x: 0, y: 0, width: 1280, height: 720 },
    crossfade: null,
    uvScale: [1, 1],
    uvOffset: [0, 0],
    ...overrides,
  };
}

function makeFakeFrame(): VideoFrame {
  return { close: vi.fn(), clone: vi.fn() } as unknown as VideoFrame;
}

function makeFakeCursor(frameAtImpl?: (t: number) => Promise<VideoFrame | null>) {
  return {
    frameAt: vi.fn(frameAtImpl ?? (async () => makeFakeFrame())),
    close: vi.fn(),
  };
}

beforeEach(() => {
  openMock.mockReset();
});

describe('TimelineDecoderFrameProvider', () => {
  it('returns null for audio and still-image clips without opening a cursor', async () => {
    const provider = new TimelineDecoderFrameProvider();
    const audioClip = makeClip({ kind: 'audio' });
    const stillClip = makeClip({ stillImage: true });

    expect(await provider.getFrame(makeLayer(), audioClip)).toBeNull();
    expect(await provider.getFrame(makeLayer(), stillClip)).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
  });

  it('opens one cursor per layer occurrence and reuses it across calls', async () => {
    const cursor = makeFakeCursor();
    openMock.mockResolvedValue(cursor);
    const provider = new TimelineDecoderFrameProvider();
    const clip = makeClip();
    const layer = makeLayer({ sourceTime: 0 });

    await provider.getFrame(layer, clip);
    await provider.getFrame({ ...layer, sourceTime: 1 / 30 }, clip);

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(cursor.frameAt).toHaveBeenCalledTimes(2);
    expect(provider.activeCount).toBe(1);
  });

  it('gives PiP and base layers on the same clip independent cursors', async () => {
    openMock.mockImplementation(async () => makeFakeCursor());
    const provider = new TimelineDecoderFrameProvider();
    const clip = makeClip();
    const baseLayer = makeLayer({ kind: 'base' });
    const pipLayer = makeLayer({ kind: 'pip' });

    await provider.getFrame(baseLayer, clip);
    await provider.getFrame(pipLayer, clip);

    expect(openMock).toHaveBeenCalledTimes(2);
    expect(provider.activeCount).toBe(2);
  });

  it('marks a clip unsupported after a failed open and never retries it', async () => {
    openMock.mockRejectedValue(new Error('unsupported codec'));
    const provider = new TimelineDecoderFrameProvider();
    const clip = makeClip();
    const layer = makeLayer();

    expect(await provider.getFrame(layer, clip)).toBeNull();
    expect(await provider.getFrame(layer, clip)).toBeNull();

    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it('reopens the cursor on a backward jump instead of reusing the forward-only one', async () => {
    const firstCursor = makeFakeCursor();
    const secondCursor = makeFakeCursor();
    openMock.mockResolvedValueOnce(firstCursor).mockResolvedValueOnce(secondCursor);
    const provider = new TimelineDecoderFrameProvider();
    const clip = makeClip();
    const layer = makeLayer();

    await provider.getFrame({ ...layer, sourceTime: 2 }, clip);
    await provider.getFrame({ ...layer, sourceTime: 0.1 }, clip); // backward jump

    expect(openMock).toHaveBeenCalledTimes(2);
    expect(firstCursor.close).toHaveBeenCalledTimes(1);
  });

  it('closes and forgets a cursor once it reports exhaustion', async () => {
    const cursor = makeFakeCursor(async () => null);
    openMock.mockResolvedValue(cursor);
    const provider = new TimelineDecoderFrameProvider();
    const clip = makeClip();

    const frame = await provider.getFrame(makeLayer(), clip);

    expect(frame).toBeNull();
    expect(cursor.close).toHaveBeenCalledTimes(1);
    expect(provider.activeCount).toBe(0);
  });

  it('bounds concurrent cursors, evicting the oldest once the cap is reached', async () => {
    openMock.mockImplementation(async () => makeFakeCursor());
    const provider = new TimelineDecoderFrameProvider(2);
    const clip = makeClip();

    await provider.getFrame(makeLayer({ timelineIndex: 0 }), clip);
    await provider.getFrame(makeLayer({ timelineIndex: 1 }), clip);
    expect(provider.activeCount).toBe(2);

    await provider.getFrame(makeLayer({ timelineIndex: 2 }), clip);
    expect(provider.activeCount).toBe(2);
  });

  it('destroy() closes every live cursor', async () => {
    openMock.mockImplementation(async () => makeFakeCursor());
    const provider = new TimelineDecoderFrameProvider();
    const clip = makeClip();

    await provider.getFrame(makeLayer({ timelineIndex: 0 }), clip);
    await provider.getFrame(makeLayer({ timelineIndex: 1 }), clip);
    provider.destroy();

    expect(provider.activeCount).toBe(0);
  });
});
