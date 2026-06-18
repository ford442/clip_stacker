/**
 * Integration test for the plan -> draw path of TimelinePreviewEngine.
 *
 * Unlike timelinePreview.test.ts (which unit-tests the pure helpers), this
 * drives the real buildPreviewCompositionPlan -> renderPlan() pipeline and
 * asserts the per-layer GPU draw calls: how many layers are drawn, which one
 * clears the canvas, and the normalized PiP destRect / opacity handed to the
 * shader. WebGPU + VideoFrame are unavailable under happy-dom, so we mock the
 * three external seams (PreviewEngine draw calls, the media pool's video
 * element, and the VideoFrame constructor) and exercise everything in between.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { buildPreviewCompositionPlan } from '../utils/previewComposition';
import type { LayerRenderParams } from './previewEngine';

// Replace the WebGPU PreviewEngine with a spy double so TimelinePreviewEngine
// can be constructed without a GPU adapter and we can observe draw calls.
vi.mock('./previewEngine', () => ({
  PreviewEngine: { create: vi.fn() },
}));

import { PreviewEngine } from './previewEngine';
import {
  ClipMediaPool,
  TimelinePreviewEngine,
} from './timelinePreview';

interface FrameInstance {
  close: ReturnType<typeof vi.fn>;
}

let renderLayer: ReturnType<typeof vi.fn>;
let clearToBlack: ReturnType<typeof vi.fn>;
let createdFrames: FrameInstance[];

function makeClip(id: string, overrides: Partial<Clip> = {}): Clip {
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
    ...overrides,
  };
}

/** Minimal stand-in for the hidden <video> the media pool would decode. */
function makeFakeVideo() {
  return {
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 0,
    readyState: 4, // HAVE_ENOUGH_DATA — passes captureVideoFrame's gate
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;
}

async function renderClipsAt(clips: Clip[], globalTime: number) {
  const engine = await TimelinePreviewEngine.create(
    document.createElement('canvas'),
    clips,
  );
  const plan = buildPreviewCompositionPlan(
    clips,
    [],
    [],
    [],
    undefined,
    globalTime,
  );
  // Drive the real plan -> draw path directly.
  await (
    engine as unknown as {
      renderPlan: (p: typeof plan) => Promise<void>;
    }
  ).renderPlan(plan);
  return plan;
}

beforeEach(() => {
  renderLayer = vi.fn();
  clearToBlack = vi.fn();
  createdFrames = [];

  vi.mocked(PreviewEngine.create).mockResolvedValue({
    renderLayer,
    clearToBlack,
    destroy: vi.fn(),
  } as unknown as PreviewEngine);

  // Every getVideo() call returns a ready fake video so seek + capture succeed.
  vi.spyOn(ClipMediaPool.prototype, 'getVideo').mockImplementation(() =>
    makeFakeVideo(),
  );

  // Stub the VideoFrame constructor; track instances so we can assert close().
  class FakeVideoFrame {
    displayWidth: number;
    displayHeight: number;
    close = vi.fn();
    constructor(video: { videoWidth: number; videoHeight: number }) {
      this.displayWidth = video.videoWidth;
      this.displayHeight = video.videoHeight;
      createdFrames.push(this);
    }
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

describe('TimelinePreviewEngine.renderPlan', () => {
  it('draws the single active base clip when scrubbing a 2-clip stack', async () => {
    const clips = [makeClip('a'), makeClip('b')];

    // t=2 falls inside clip "a" (0-5s) only.
    await renderClipsAt(clips, 2);

    expect(renderLayer).toHaveBeenCalledTimes(1);
    expect(clearToBlack).not.toHaveBeenCalled();

    const params = renderLayer.mock.calls[0][1] as LayerRenderParams;
    expect(params.clear).toBe(true);
    expect(params.destRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(params.elapsed).toBeCloseTo(2);

    // Frame released after drawing.
    expect(createdFrames).toHaveLength(1);
    expect(createdFrames[0].close).toHaveBeenCalledTimes(1);
  });

  it('draws clip "b" (not "a") after the cut boundary', async () => {
    const clips = [makeClip('a'), makeClip('b')];

    // t=7 falls inside clip "b" (5-10s).
    await renderClipsAt(clips, 7);

    expect(renderLayer).toHaveBeenCalledTimes(1);
    const params = renderLayer.mock.calls[0][1] as LayerRenderParams;
    expect(params.elapsed).toBeCloseTo(2); // 7 - 5
  });

  it('composites a PiP overlay above the base layer with normalized rect + opacity', async () => {
    const base = makeClip('base');
    const pip = makeClip('pip', {
      layerIndex: 1,
      x: 128,
      y: 72,
      width: 320,
      height: 180,
      opacity: 0.5,
    });

    await renderClipsAt([base, pip], 1);

    // Base drawn first (clears), PiP drawn over it.
    expect(renderLayer).toHaveBeenCalledTimes(2);

    const baseParams = renderLayer.mock.calls[0][1] as LayerRenderParams;
    expect(baseParams.clear).toBe(true);
    expect(baseParams.destRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });

    const pipParams = renderLayer.mock.calls[1][1] as LayerRenderParams;
    expect(pipParams.clear).toBe(false);
    // 1280x720 canvas (default): 128/1280=0.1, 72/720=0.1, 320/1280=0.25, 180/720=0.25
    expect(pipParams.destRect).toEqual({ x: 0.1, y: 0.1, w: 0.25, h: 0.25 });
    expect(pipParams.opacity).toBeCloseTo(0.5);
  });

  it('draws outgoing + incoming layers with complementary opacity during a dissolve', async () => {
    const clips = [makeClip('a'), makeClip('b')];
    const transitions = [{ afterClipIndex: 1, type: 'dissolve' as const, duration: 2 }];

    // Clip "b" starts at t=3 (5s - 2s overlap); overlap window is 3-5s.
    // t=4 is the midpoint -> crossfade progress 0.5.
    const engine = await TimelinePreviewEngine.create(
      document.createElement('canvas'),
      clips,
    );
    const plan = buildPreviewCompositionPlan(clips, [], transitions, [], undefined, 4);
    await (
      engine as unknown as { renderPlan: (p: typeof plan) => Promise<void> }
    ).renderPlan(plan);

    expect(renderLayer).toHaveBeenCalledTimes(2);

    const outgoing = renderLayer.mock.calls[0][1] as LayerRenderParams;
    const incoming = renderLayer.mock.calls[1][1] as LayerRenderParams;

    // Outgoing clip draws first (clears), fading out; incoming draws over it.
    expect(outgoing.clear).toBe(true);
    expect(incoming.clear).toBe(false);
    expect(outgoing.opacity).toBeCloseTo(0.5);
    expect(incoming.opacity).toBeCloseTo(0.5);
    expect(outgoing.opacity + incoming.opacity).toBeCloseTo(1);
  });

  it('clears to black when no clip layer is active at the playhead', async () => {
    const clips = [makeClip('a'), makeClip('b')];

    // t=999 is past the 10s total duration -> empty plan.
    await renderClipsAt(clips, 999);

    expect(renderLayer).not.toHaveBeenCalled();
    expect(clearToBlack).toHaveBeenCalledTimes(1);
  });
});
