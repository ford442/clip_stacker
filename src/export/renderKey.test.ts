import { describe, expect, it } from 'vitest';
import type { Clip, TextOverlay } from '../types';
import { buildPreviewCompositionPlan } from '../composition/previewComposition';
import { createTestClip } from '../project/project.test.helpers';
import {
  canonicalJson,
  finishingIsFrameSeeded,
  finishingIsTemporal,
  frameKey,
  quantizePlan,
  renderSettingsHash,
  segmentFrames,
  type FrameKey,
  type FrameKeyContext,
} from './renderKey';

const SETTINGS = { outputResolution: '640x360' };
const FPS = 30;

function clip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
  return { ...createTestClip(id, duration), videoWidth: 640, videoHeight: 360, ...overrides };
}

/** Every clip decodes "media-<file name>", so clips sharing a file share media. */
function context(clips: Clip[], overrides: Partial<FrameKeyContext> = {}): FrameKeyContext {
  return {
    clipsById: new Map(clips.map((c) => [c.id, c])),
    mediaKey: (c) => `media-${c.file.name}`,
    settingsHash: renderSettingsHash({ width: 640, height: 360, buildId: 'test' }),
    grainSeed: null,
    ...overrides,
  };
}

function keysFor(clips: Clip[], overlays: TextOverlay[], frames: number, ctx = context(clips)): FrameKey[] {
  const out: FrameKey[] = [];
  for (let i = 0; i < frames; i++) {
    const plan = buildPreviewCompositionPlan(clips, [], [], overlays, SETTINGS, i / FPS, 360, 640);
    out.push(frameKey(quantizePlan(plan), ctx));
  }
  return out;
}

/** A title keyframed visible only between `from` and `to` (opacity 0 elsewhere). */
function title(text: string, from: number, to: number): TextOverlay {
  return {
    id: 't1',
    text,
    x: 0.1,
    y: 0.1,
    fontsize: 32,
    fontcolor: '#ffffff',
    scrolling: false,
    scrollSpeed: 0,
    keyframes: {
      opacity: [
        { t: 0, value: 0 },
        { t: from - 0.001, value: 0 },
        { t: from, value: 1 },
        { t: to, value: 1 },
        { t: to + 0.001, value: 0 },
      ],
    },
  } as TextOverlay;
}

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(Number.NaN)).toBe('null');
  });
});

describe('frameKey', () => {
  it('is stable across rebuilt plans and ignores clip ids', () => {
    const a = [clip('a', 4)];
    const renamed = [{ ...clip('renamed', 4), file: a[0]!.file }];
    expect(keysFor(a, [], 3).map((f) => f.key)).toEqual(keysFor(a, [], 3).map((f) => f.key));
    expect(keysFor(renamed, [], 3).map((f) => f.key)).toEqual(keysFor(a, [], 3).map((f) => f.key));
  });

  it('changes with the media, the source time, the trim and the settings', () => {
    const a = [clip('a', 4)];
    const [first, second] = keysFor(a, [], 2);
    expect(first!.key).not.toBe(second!.key);
    const otherMedia = keysFor(a, [], 1, context(a, { mediaKey: () => 'other' }))[0]!;
    expect(otherMedia.key).not.toBe(first!.key);
    const trimmed = [clip('a', 4, { trimEnd: 3 })];
    expect(keysFor(trimmed, [], 1)[0]!.key).not.toBe(first!.key);
    const graded = context(a, {
      settingsHash: renderSettingsHash({
        width: 640,
        height: 360,
        buildId: 'test',
        finishing: { grain: { enabled: true, amount: 0.5 } } as never,
      }),
    });
    expect(keysFor(a, [], 1, graded)[0]!.key).not.toBe(first!.key);
  });

  it('keys a frame by its picture, not its output time: a rippled clip keeps its keys', () => {
    const a = clip('a', 2);
    const b = clip('b', 3);
    const before = keysFor([a, b], [], 150);
    const shorter = { ...a, trimEnd: 1 }; // ripple: b now starts 1 s earlier
    const after = keysFor([shorter, b], [], 120);
    // b's frames: output 60..149 before, 30..119 after.
    expect(after.slice(30).map((f) => f.key)).toEqual(before.slice(60).map((f) => f.key));
  });

  it('a title only changes the frames it covers', () => {
    const clips = [clip('a', 4)];
    const plain = keysFor(clips, [title('Hello', 1, 2)], 120);
    const edited = keysFor(clips, [title('World', 1, 2)], 120);
    const changed = plain.flatMap((f, i) => (f.key !== edited[i]!.key ? [i] : []));
    expect(changed[0]).toBe(30);
    expect(changed.at(-1)).toBe(60);
    expect(changed).toHaveLength(31);
  });

  it('seeds by the grain frame when grain is on', () => {
    const clips = [clip('a', 4)];
    const plan = buildPreviewCompositionPlan(clips, [], [], [], SETTINGS, 1, 360, 640);
    const k1 = frameKey(plan, context(clips, { grainSeed: 30 })).key;
    const k2 = frameKey(plan, context(clips, { grainSeed: 31 })).key;
    expect(k1).not.toBe(k2);
  });

  it('refuses to key RIFE segments, offline clips and media with no fingerprint', () => {
    const offline = [clip('a', 4, { offline: { fileName: 'a.mp4' } })];
    expect(keysFor(offline, [], 1)[0]!).toMatchObject({ key: null, uncacheable: 'an offline clip (slate)' });
    const unknown = [clip('a', 4)];
    expect(keysFor(unknown, [], 1, context(unknown, { mediaKey: () => null }))[0]!.key).toBeNull();
    const plan = buildPreviewCompositionPlan(unknown, [], [], [], SETTINGS, 1, 360, 640);
    const layer = plan.layers[0]!;
    if (layer.kind !== 'base') throw new Error('expected a base layer');
    const morph = { ...plan, layers: [{ ...layer, mediaObjectUrl: 'blob:morph' }] };
    expect(frameKey(morph, context(unknown)).uncacheable).toMatch(/RIFE/);
  });
});

describe('quantizePlan', () => {
  it('snaps source times to microseconds and keeps ids and strings', () => {
    const plan = buildPreviewCompositionPlan([clip('a', 4)], [], [], [], SETTINGS, 2.1 - 2 + 1, 360, 640);
    const quantized = quantizePlan(plan);
    const layer = quantized.layers[0]!;
    if (layer.kind !== 'base') throw new Error('expected a base layer');
    expect(layer.sourceTime * 1e6).toBeCloseTo(Math.round(layer.sourceTime * 1e6), 6);
    expect(layer.clipId).toBe('a');
    expect(quantizePlan(quantized)).toEqual(quantized);
  });
});

describe('segmentFrames', () => {
  const frame = (key: string | null, structure = 's'): FrameKey => ({ key, structure });

  it('splits at structure changes and every maxFrames from the run start', () => {
    const frames = [
      ...Array.from({ length: 5 }, (_, i) => frame(`a${i}`, 'A')),
      ...Array.from({ length: 7 }, (_, i) => frame(`b${i}`, 'B')),
    ];
    const segments = segmentFrames(frames, { maxFrames: 3, startFrame: 100 });
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [100, 103],
      [103, 105],
      [105, 108],
      [108, 111],
      [111, 112],
    ]);
  });

  it('keys a segment by its frames in order', () => {
    const one = segmentFrames([frame('x'), frame('y')]);
    const swapped = segmentFrames([frame('y'), frame('x')]);
    expect(one[0]!.key).not.toBe(swapped[0]!.key);
    expect(segmentFrames([frame('x'), frame('y')])[0]!.key).toBe(one[0]!.key);
  });

  it('isolates uncacheable frames into keyless segments', () => {
    const frames = [frame('a'), frame('b'), { key: null, structure: 's', uncacheable: 'why' }, frame('c')];
    const segments = segmentFrames(frames);
    expect(segments.map((s) => [s.start, s.end, s.key === null])).toEqual([
      [0, 2, false],
      [2, 3, true],
      [3, 4, false],
    ]);
    expect(segments[1]!.uncacheable).toBe('why');
  });

  it('keeps a moved clip on the same segment keys', () => {
    const run = Array.from({ length: 130 }, (_, i) => frame(`b${i}`, 'B'));
    const early = segmentFrames([...Array.from({ length: 10 }, (_, i) => frame(`a${i}`, 'A')), ...run]);
    const late = segmentFrames([...Array.from({ length: 47 }, (_, i) => frame(`a${i}`, 'A')), ...run]);
    expect(early.slice(1).map((s) => s.key)).toEqual(late.slice(1).map((s) => s.key));
  });
});

describe('finishing flags', () => {
  it('temporal only with temporal NR on and active', () => {
    expect(finishingIsTemporal(undefined)).toBe(false);
    expect(
      finishingIsTemporal({
        noiseReduction: { enabled: true, amount: 1, spatialStrength: 0, temporal: true, temporalStrength: 0.4 },
      } as never),
    ).toBe(true);
    expect(
      finishingIsTemporal({
        noiseReduction: { enabled: true, amount: 1, spatialStrength: 0.5, temporal: false, temporalStrength: 0.4 },
      } as never),
    ).toBe(false);
    expect(finishingIsFrameSeeded({ grain: { enabled: true, amount: 0.5 } } as never)).toBe(true);
  });
});
