import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { buildPreviewCompositionPlan } from '../utils/previewComposition';
import { PreviewEngine } from './previewEngine';
import { ClipMediaPool, TimelinePreviewEngine } from './timelinePreview';

vi.mock('./previewEngine', () => ({
  PreviewEngine: { create: vi.fn() },
}));

let renderLayer: ReturnType<typeof vi.fn>;
let clearToBlack: ReturnType<typeof vi.fn>;

function makeClip(id: string): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

function makeFakeVideo() {
  return {
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 0,
    readyState: 4,
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;
}

beforeEach(() => {
  renderLayer = vi.fn();
  clearToBlack = vi.fn();

  vi.mocked(PreviewEngine.create).mockResolvedValue({
    renderLayer,
    clearToBlack,
    destroy: vi.fn(),
  } as unknown as PreviewEngine);

  vi.spyOn(ClipMediaPool.prototype, 'getVideo').mockImplementation(() =>
    makeFakeVideo(),
  );

  class FakeVideoFrame {
    displayWidth = 1280;
    displayHeight = 720;
    close = vi.fn();
    constructor() {}
  }
  vi.stubGlobal('VideoFrame', FakeVideoFrame);
  if (typeof (globalThis as { HTMLMediaElement?: unknown }).HTMLMediaElement === 'undefined') {
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TimelinePreviewEngine cancellation', () => {
  it('skips GPU draws when isCancelled returns true before renderPlan', async () => {
    const engine = await TimelinePreviewEngine.create(
      document.createElement('canvas'),
      [makeClip('a'), makeClip('b')],
    );
    const plan = buildPreviewCompositionPlan(
      [makeClip('a'), makeClip('b')],
      [],
      [],
      [],
      undefined,
      2,
    );

    await (
      engine as unknown as {
        renderPlan: (
          p: typeof plan,
          options?: { isCancelled?: () => boolean },
        ) => Promise<void>;
      }
    ).renderPlan(plan, { isCancelled: () => true });

    expect(renderLayer).not.toHaveBeenCalled();
    expect(clearToBlack).not.toHaveBeenCalled();
  });
});
