import { describe, expect, it } from 'vitest';
import type { CaptionEntry, Clip } from '../types';
import {
  buildPreviewCompositionPlan,
  captionPlanOptions,
  type PreviewCaptionLayer,
  type PreviewClipLayer,
} from './previewComposition';
import { KEY_MODE } from './overlayKey';

function makeClip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

function cue(overrides: Partial<CaptionEntry> = {}): CaptionEntry {
  return {
    id: 'cue-1',
    startSec: 1,
    endSec: 3,
    text: 'Hello there',
    ...overrides,
  };
}

/** 1280x720 output, uncapped preview, so canvas px == output px. */
const SETTINGS = { outputResolution: '1280x720' } as const;

function planAt(globalTime: number, captions: CaptionEntry[]) {
  return buildPreviewCompositionPlan(
    [makeClip('a', 10)],
    [],
    [],
    [],
    SETTINGS,
    globalTime,
    720,
    1280,
    { captions },
  );
}

function captionLayers(
  plan: ReturnType<typeof buildPreviewCompositionPlan>,
): PreviewCaptionLayer[] {
  return plan.layers.filter(
    (layer): layer is PreviewCaptionLayer => layer.kind === 'caption',
  );
}

describe('caption layers in the composition plan', () => {
  it('emits the cue active at a mid-cue timestamp', () => {
    const layers = captionLayers(planAt(2, [cue()]));
    expect(layers).toHaveLength(1);
    expect(layers[0].captionId).toBe('cue-1');
    expect(layers[0].text).toBe('Hello there');
  });

  it('emits nothing before, at the out-point, or after the cue', () => {
    expect(captionLayers(planAt(0.5, [cue()]))).toHaveLength(0);
    // End is exclusive, matching captionsAtTime and the CC lane.
    expect(captionLayers(planAt(3, [cue()]))).toHaveLength(0);
    expect(captionLayers(planAt(5, [cue()]))).toHaveLength(0);
  });

  it('emits every overlapping cue, in start order', () => {
    const layers = captionLayers(
      planAt(2, [
        cue({ id: 'b', startSec: 1.5, endSec: 4, text: 'second' }),
        cue({ id: 'a', startSec: 1, endSec: 3, text: 'first' }),
      ]),
    );
    expect(layers.map((l) => l.captionId)).toEqual(['a', 'b']);
  });

  it('anchors at bottom centre in canvas pixels', () => {
    const [layer] = captionLayers(planAt(2, [cue()]));
    // DEFAULT_CAPTION_STYLE: x 0.5, y 0.92 — fractions of the output size.
    expect(layer.x).toBeCloseTo(640);
    expect(layer.y).toBeCloseTo(662.4);
  });

  it('scales the anchor with a capped preview canvas', () => {
    const plan = buildPreviewCompositionPlan(
      [makeClip('a', 10)],
      [],
      [],
      [],
      SETTINGS,
      2,
      360,
      640,
      { captions: [cue()] },
    );
    const [layer] = captionLayers(plan);
    expect(layer.x).toBeCloseTo(plan.canvasWidth * 0.5);
    expect(layer.y).toBeCloseTo(plan.canvasHeight * 0.92);
  });

  it('merges per-cue style over the project style over the defaults', () => {
    const plan = buildPreviewCompositionPlan(
      [makeClip('a', 10)],
      [],
      [],
      [],
      SETTINGS,
      2,
      720,
      1280,
      {
        captions: [cue({ style: { fontcolor: '#ff0000' } })],
        captionStyle: { fontsize: 48, fontcolor: '#00ff00', box: false },
      },
    );
    const [layer] = captionLayers(plan);
    expect(layer.style.fontsize).toBe(48);
    // Per-cue override wins over the project style.
    expect(layer.style.fontcolor).toBe('#ff0000');
    expect(layer.style.box).toBe(false);
  });

  it('draws above text overlays', () => {
    const plan = buildPreviewCompositionPlan(
      [makeClip('a', 10)],
      [],
      [],
      [
        {
          id: 'overlay-1',
          text: 'title',
          fontsize: 40,
          fontcolor: 'white',
          x: 0.1,
          y: 0.1,
          startTime: 0,
          endTime: 10,
        } as never,
      ],
      SETTINGS,
      2,
      720,
      1280,
      { captions: [cue()] },
    );
    const kinds = plan.layers.map((layer) => layer.kind);
    expect(kinds.indexOf('caption')).toBeGreaterThan(kinds.indexOf('text'));
  });

  it('leaves the plan caption-free when no cues are passed', () => {
    expect(captionLayers(planAt(2, []))).toHaveLength(0);
    const plan = buildPreviewCompositionPlan(
      [makeClip('a', 10)],
      [],
      [],
      [],
      SETTINGS,
      2,
    );
    expect(captionLayers(plan)).toHaveLength(0);
  });

  it('skips a cue with no text', () => {
    expect(captionLayers(planAt(2, [cue({ text: '' })]))).toHaveLength(0);
  });
});

describe('captionPlanOptions', () => {
  it('narrows render options down to the caption inputs', () => {
    const captions = [cue()];
    expect(
      captionPlanOptions({ captions, captionStyle: { fontsize: 20 } }),
    ).toEqual({ captions, captionStyle: { fontsize: 20 } });
    expect(captionPlanOptions(undefined)).toEqual({
      captions: undefined,
      captionStyle: undefined,
    });
  });
});

describe('layer keys in the composition plan', () => {
  function pipLayer(clip: Clip): PreviewClipLayer {
    const plan = buildPreviewCompositionPlan(
      [makeClip('base', 10), clip],
      [],
      [],
      [],
      SETTINGS,
      2,
      720,
      1280,
    );
    return plan.layers.find(
      (layer): layer is PreviewClipLayer => layer.kind === 'pip',
    )!;
  }

  it('carries the chroma key onto a keyed PiP layer', () => {
    const layer = pipLayer(
      makeClip('pip', 10, {
        layerIndex: 1,
        overlayBlend: 'chroma',
        chromaKey: { color: '#00FF00', similarity: 0.35, blend: 0.05 },
      }),
    );
    expect(layer.key).toEqual({
      mode: KEY_MODE.chroma,
      keyR: 0,
      keyG: 1,
      keyB: 0,
      similarity: 0.35,
      blend: 0.05,
    });
  });

  it('omits the key entirely on an unkeyed layer', () => {
    const layer = pipLayer(makeClip('pip', 10, { layerIndex: 1 }));
    expect('key' in layer).toBe(false);
  });

  it('carries the key onto a keyed base layer too', () => {
    const plan = buildPreviewCompositionPlan(
      [makeClip('a', 10, { overlayBlend: 'luma' })],
      [],
      [],
      [],
      SETTINGS,
      2,
      720,
      1280,
    );
    const base = plan.layers.find(
      (layer): layer is PreviewClipLayer => layer.kind === 'base',
    )!;
    expect(base.key?.mode).toBe(KEY_MODE.luma);
  });
});
