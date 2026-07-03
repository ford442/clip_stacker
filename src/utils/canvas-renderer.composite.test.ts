/**
 * Tests for the Canvas2D fallback compositor (`compositeFrame`).
 *
 * Drives the real buildPreviewCompositionPlan -> compositeFrame path against a
 * recording 2D-context double, asserting layer draw order, letterbox layout,
 * and per-layer opacity. The letterbox rect is cross-checked against the WebGPU
 * path's computeLetterboxUv to prove visual parity for the base case.
 */
import { describe, it, expect } from 'vitest';
import type { Clip } from '../types';
import { buildPreviewCompositionPlan } from './previewComposition';
import { compositeFrame, type FrameSource } from './canvas-renderer';
import { computeLetterboxUv } from '../webgpu/exportCompositor';

type Call = [op: string, ...args: unknown[]];

function makeMockCtx() {
  const calls: Call[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '' as string | CanvasGradient,
    font: '',
    textBaseline: '' as CanvasTextBaseline,
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push(['fillRect', this.globalAlpha, this.fillStyle, x, y, w, h]);
    },
    drawImage(img: unknown, ...args: number[]) {
      if (args.length === 4) {
        calls.push(['drawImage', this.globalAlpha, args[0], args[1], args[2], args[3]]);
      } else if (args.length === 8) {
        calls.push(['drawImage', this.globalAlpha, args[4], args[5], args[6], args[7]]);
      }
    },
    fillText(text: string, x: number, y: number) {
      calls.push(['fillText', this.globalAlpha, this.fillStyle, text, x, y]);
    },
    measureText(text: string) {
      return { width: text.length * 10 } as TextMetrics;
    },
  };
  return { ctx, calls };
}

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

function source(width: number, height: number): FrameSource {
  return { image: {} as CanvasImageSource, width, height };
}

const drawImageCalls = (calls: Call[]) =>
  calls.filter((c) => c[0] === 'drawImage');

describe('compositeFrame', () => {
  it('clears to black then draws the active base clip letterboxed (parity with WebGPU)', () => {
    const clips = [makeClip('a'), makeClip('b')];
    const plan = buildPreviewCompositionPlan(clips, [], [], [], undefined, 2);
    const { ctx, calls } = makeMockCtx();

    // 4:3 source into the default 16:9 canvas -> pillarboxed.
    compositeFrame(ctx as unknown as CanvasRenderingContext2D, plan, new Map([
      ['a', source(640, 480)],
    ]));

    // First op clears the whole canvas to black.
    expect(calls[0]).toEqual(['fillRect', 1, '#000', 0, 0, 1280, 720]);

    const draws = drawImageCalls(calls);
    expect(draws).toHaveLength(1);

    // Expected letterbox rect from the WebGPU path's UV math.
    const { uvScale, uvOffset } = computeLetterboxUv(640, 480, 1280, 720);
    const expectedX = uvOffset[0] * 1280;
    const expectedY = uvOffset[1] * 720;
    const expectedW = uvScale[0] * 1280;
    const expectedH = uvScale[1] * 720;

    const [, alpha, x, y, w, h] = draws[0];
    expect(alpha).toBe(1);
    expect(x).toBeCloseTo(expectedX);
    expect(y).toBeCloseTo(expectedY);
    expect(w).toBeCloseTo(expectedW);
    expect(h).toBeCloseTo(expectedH);
    // Concretely: 960x720 centered at x=160.
    expect([x, y, w, h]).toEqual([160, 0, 960, 720]);
  });

  it('draws a PiP overlay above the base layer at reduced opacity', () => {
    const base = makeClip('base');
    const pip = makeClip('pip', {
      layerIndex: 1,
      x: 128,
      y: 72,
      width: 320,
      height: 180,
      opacity: 0.5,
    });
    const plan = buildPreviewCompositionPlan([base, pip], [], [], [], undefined, 1);
    const { ctx, calls } = makeMockCtx();

    compositeFrame(
      ctx as unknown as CanvasRenderingContext2D,
      plan,
      new Map([
        ['base', source(1280, 720)],
        ['pip', source(320, 180)], // exact fit -> no inner letterbox
      ]),
    );

    const draws = drawImageCalls(calls);
    expect(draws).toHaveLength(2);

    // Base first at full opacity, then PiP over it at 0.5.
    expect(draws[0][1]).toBe(1);
    const [, pipAlpha, px, py, pw, ph] = draws[1];
    expect(pipAlpha).toBeCloseTo(0.5);
    expect([px, py, pw, ph]).toEqual([128, 72, 320, 180]);
  });

  it('draws dissolve outgoing + incoming with complementary opacity', () => {
    const clips = [makeClip('a'), makeClip('b')];
    const transitions = [{ afterClipIndex: 1, type: 'dissolve' as const, duration: 2 }];
    // Overlap window 3-5s; t=4 -> progress 0.5.
    const plan = buildPreviewCompositionPlan(clips, [], transitions, [], undefined, 4);
    const { ctx, calls } = makeMockCtx();

    compositeFrame(
      ctx as unknown as CanvasRenderingContext2D,
      plan,
      new Map([
        ['a', source(1280, 720)],
        ['b', source(1280, 720)],
      ]),
    );

    const draws = drawImageCalls(calls);
    expect(draws).toHaveLength(2);
    const outAlpha = draws[0][1] as number;
    const inAlpha = draws[1][1] as number;
    expect(outAlpha).toBeCloseTo(0.5);
    expect(inAlpha).toBeCloseTo(0.5);
    expect(outAlpha + inAlpha).toBeCloseTo(1);
  });

  it('skips clip layers with no decoded frame but still clears', () => {
    const clips = [makeClip('a'), makeClip('b')];
    const plan = buildPreviewCompositionPlan(clips, [], [], [], undefined, 2);
    const { ctx, calls } = makeMockCtx();

    compositeFrame(ctx as unknown as CanvasRenderingContext2D, plan, new Map());

    expect(drawImageCalls(calls)).toHaveLength(0);
    expect(calls[0]).toEqual(['fillRect', 1, '#000', 0, 0, 1280, 720]);
  });

  it('does not draw text overlays (those are a separate final pass)', () => {
    const clips = [makeClip('a'), makeClip('b')];
    const overlays = [
      {
        id: 't1',
        text: 'Hello',
        fontsize: 48,
        fontcolor: '0xffffff',
        x: 100,
        y: 50,
        scrolling: false,
        scrollSpeed: 0,
        box: false,
        boxColor: 'black@0.5',
      },
    ];
    const plan = buildPreviewCompositionPlan(clips, [], [], overlays, undefined, 2);
    const { ctx, calls } = makeMockCtx();

    compositeFrame(
      ctx as unknown as CanvasRenderingContext2D,
      plan,
      new Map([['a', source(1280, 720)]]),
    );

    // compositeFrame composites video only; text is drawn by drawTextOverlays.
    expect(calls.filter((c) => c[0] === 'fillText')).toHaveLength(0);
    expect(drawImageCalls(calls)).toHaveLength(1);
  });
});
