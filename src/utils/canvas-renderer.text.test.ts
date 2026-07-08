/**
 * Tests for the text-overlay final pass (`drawTextOverlays`) used over both
 * the WebGPU and Canvas2D video composites.
 */
import { describe, it, expect } from 'vitest';
import type { Clip, TextOverlay } from '../types';
import { buildPreviewCompositionPlan } from './previewComposition';
import { drawTextOverlays } from './canvas-renderer';
import { getBundledFont } from './textOverlay';

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
    fillText(text: string, x: number, y: number) {
      calls.push(['fillText', this.globalAlpha, this.fillStyle, text, x, y]);
    },
    // 10px per character — deterministic stand-in for real glyph metrics.
    measureText(text: string) {
      return { width: text.length * 10 } as TextMetrics;
    },
  };
  return { ctx, calls };
}

function baseClip(): Clip {
  return {
    id: 'a',
    file: new File([], 'a.mp4'),
    objectUrl: 'blob:a',
    title: 'a',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

function overlay(over: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: 't1',
    text: 'Hi',
    fontsize: 48,
    fontcolor: 'white',
    x: 100,
    y: 50,
    scrolling: false,
    scrollSpeed: 20,
    box: false,
    boxColor: 'black@0.5',
    ...over,
  };
}

function draw(overlays: TextOverlay[], globalTime: number) {
  const plan = buildPreviewCompositionPlan(
    [baseClip()],
    [],
    [],
    overlays,
    undefined,
    globalTime,
  );
  const { ctx, calls } = makeMockCtx();
  drawTextOverlays(ctx as unknown as CanvasRenderingContext2D, plan);
  return calls;
}

describe('drawTextOverlays', () => {
  it('draws a static overlay at its configured position and color', () => {
    const calls = draw([overlay({ fontcolor: '0xffcc00', x: 120, y: 60 })], 1);
    const text = calls.filter((c) => c[0] === 'fillText');
    expect(text).toHaveLength(1);
    // 0xRRGGBB normalized to CSS hex, alpha 1, drawn at (120, 60).
    expect(text[0]).toEqual(['fillText', 1, '#ffcc00', 'Hi', 120, 60]);
  });

  it('animates a scrolling ticker using the measured text width', () => {
    // scrollSpeed 20 -> fraction 0.2; text 'Hi' (2 chars) -> width 20.
    // x = w + tw - t*w*fraction = 1280 + 20 - 1*1280*0.2 = 1044.
    const calls = draw([overlay({ text: 'Hi', scrolling: true })], 1);
    const text = calls.filter((c) => c[0] === 'fillText');
    expect(text).toHaveLength(1);
    expect(text[0][4]).toBe(1044); // x argument

    // Later in playback the ticker has moved further left.
    const later = draw([overlay({ text: 'Hi', scrolling: true })], 2);
    const laterText = later.filter((c) => c[0] === 'fillText');
    expect(laterText[0][4]).toBe(1280 + 20 - 2 * 1280 * 0.2); // 788
  });

  it('draws a background box with its color alpha applied', () => {
    const calls = draw([overlay({ text: 'Box', box: true, boxColor: 'black@0.5' })], 1);
    const box = calls.find((c) => c[0] === 'fillRect');
    expect(box).toBeDefined();
    // alpha 0.5 from '@0.5', black fill, padded around the 30px-wide text.
    const [, alpha, color] = box as Call;
    expect(alpha).toBeCloseTo(0.5);
    expect(color).toBe('black');
    // pad = round(48 * 0.2) = 10; box at (100-10, 50-10, 30+20, 48+20).
    expect((box as Call).slice(3)).toEqual([90, 40, 50, 68]);
  });

  it('falls back to a default color for invalid FFmpeg colors', () => {
    const calls = draw([overlay({ fontcolor: 'not-a-real-color' })], 1);
    const text = calls.find((c) => c[0] === 'fillText') as Call;
    expect(text[2]).toBe('white');
  });

  it('draws nothing when there are no overlays', () => {
    expect(draw([], 1)).toHaveLength(0);
  });

  it('uses the selected font family for ctx.font (spot-check via registry + draw)', () => {
    // Draw with explicit font id; verify the family name we will feed to ctx.font.
    const fam = getBundledFont('mono').familyName;
    expect(fam).toMatch(/Mono/i);

    // Exercise the draw path with a mono overlay; it must not throw and must produce a fillText.
    const calls = draw([overlay({ text: 'Mono', font: 'mono' })], 0.5);
    const text = calls.filter((c) => c[0] === 'fillText');
    expect(text.length).toBeGreaterThan(0);
  });
});
