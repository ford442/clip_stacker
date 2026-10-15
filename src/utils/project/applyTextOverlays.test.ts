import { describe, expect, it } from 'vitest';
import { deserializeTextOverlays, usesPixelLayoutForProject } from './applyTextOverlays';
import { DEFAULT_TEXT_OVERLAY_X, DEFAULT_TEXT_OVERLAY_Y } from '../overlayCoords';
import { clampScrollSpeed, DEFAULT_SCROLL_SPEED } from '../textOverlay';
import { PROJECT_SCHEMA_VERSION } from '../../types';

const deserialize = (raw: unknown, usesPixelLayout = false, reference?: string) =>
  deserializeTextOverlays(raw, usesPixelLayout, reference);

describe('deserializeTextOverlays', () => {
  it('returns no overlays when the saved value is not an array', () => {
    for (const raw of [undefined, null, 'overlays', 3, { id: 'a' }]) {
      expect(deserialize(raw)).toEqual({ textOverlays: [], invalidColorWarnings: [] });
    }
  });

  it('fills every missing field with its default', () => {
    const { textOverlays, invalidColorWarnings } = deserialize([{}]);
    expect(invalidColorWarnings).toEqual([]);
    expect(textOverlays).toEqual([
      {
        id: '',
        text: '',
        fontsize: 40,
        fontcolor: '#ffffff',
        x: DEFAULT_TEXT_OVERLAY_X,
        y: DEFAULT_TEXT_OVERLAY_Y,
        scrolling: false,
        scrollSpeed: clampScrollSpeed(DEFAULT_SCROLL_SPEED),
        box: false,
        boxColor: 'black@0.5',
      },
    ]);
  });

  it('drops entries that are not objects instead of throwing', () => {
    const { textOverlays, invalidColorWarnings } = deserialize([
      null,
      'title',
      7,
      ['nested'],
      { id: 'kept', fontcolor: 'nope' },
    ]);
    expect(textOverlays.map((o) => o.id)).toEqual(['kept']);
    // The warning label still counts the entry's position in the saved array.
    expect(invalidColorWarnings).toEqual([
      'Text overlay #5: invalid font color "nope" reset to #ffffff.',
    ]);
  });

  it('coerces scalar fields from loosely typed JSON', () => {
    const [overlay] = deserialize([
      { id: 12, text: 34, fontsize: '18', x: '0.25', y: 0.5, scrolling: 1, box: 'yes' },
    ]).textOverlays;
    expect(overlay).toMatchObject({
      id: '12',
      text: '34',
      fontsize: 18,
      x: 0.25,
      y: 0.5,
      scrolling: true,
      box: true,
    });
  });

  it('keeps known fonts and falls back to the default for unknown ones', () => {
    const { textOverlays } = deserialize([
      { id: 'a', font: ' robotoBold ' },
      { id: 'b', font: 'comic-sans' },
      { id: 'c', font: 42 },
    ]);
    expect(textOverlays[0].font).toBe('robotoBold');
    expect(textOverlays[1].font).toBeUndefined();
    expect(textOverlays[2].font).toBeUndefined();
  });

  it('keeps a known shader fill and drops malformed shader params and colors', () => {
    const [overlay] = deserialize([
      {
        id: 'a',
        fill: 'shader',
        shaderId: 'plasma',
        shaderParams: { scale: 4, speed: '2', bad: Number.NaN },
        shaderColors: { color1: '#ff0000', color2: 5 },
      },
    ]).textOverlays;
    expect(overlay.fill).toBe('shader');
    expect(overlay.shaderId).toBe('plasma');
    expect(overlay.shaderParams).toEqual({ scale: 4 });
    expect(overlay.shaderColors).toEqual({ color1: '#ff0000' });
  });

  it('ignores an unknown fill / shader id with a warning', () => {
    const { textOverlays, invalidColorWarnings } = deserialize([
      { id: 'a', text: 'Hi', fill: 'glitter', shaderId: 'nope', shaderParams: [1, 2] },
    ]);
    expect(textOverlays[0].fill).toBeUndefined();
    expect(textOverlays[0].shaderId).toBeUndefined();
    expect(textOverlays[0].shaderParams).toBeUndefined();
    expect(invalidColorWarnings).toEqual([
      'Text overlay "Hi": unknown shader "nope" — falling back to solid color.',
    ]);
  });

  it('keeps well-formed keyframes and drops malformed ones', () => {
    const [overlay] = deserialize([
      {
        id: 'a',
        keyframes: {
          x: [
            { t: 0, value: 0.1 },
            { t: 1, value: 0.9, easing: { type: 'bezier', x1: 0.4, y1: 'a' } },
            { t: 'late', value: 0.5 },
            null,
          ],
          opacity: [{ t: 0, value: 1, easing: { type: 'wobble' } }],
          y: 'not-a-track',
          rotation: [{ t: 0, value: 45 }],
        },
      },
    ]).textOverlays;
    expect(overlay.keyframes).toEqual({
      x: [
        { t: 0, value: 0.1 },
        { t: 1, value: 0.9, easing: { type: 'bezier', x1: 0.4 } },
      ],
      opacity: [{ t: 0, value: 1 }],
    });
  });

  it('omits keyframes that are not an object', () => {
    const { textOverlays } = deserialize([
      { id: 'a', keyframes: 'x' },
      { id: 'b', keyframes: [{ t: 0, value: 1 }] },
    ]);
    expect(textOverlays[0]).not.toHaveProperty('keyframes');
    expect(textOverlays[1]).not.toHaveProperty('keyframes');
  });

  it('migrates legacy pixel positions and position keyframes', () => {
    const [overlay] = deserialize(
      [
        {
          id: 'a',
          x: 192,
          y: 540,
          keyframes: { x: [{ t: 0, value: 960 }], opacity: [{ t: 0, value: 0.5 }] },
        },
      ],
      true,
      '1920x1080',
    ).textOverlays;
    expect(overlay.x).toBeCloseTo(0.1);
    expect(overlay.y).toBeCloseTo(0.5);
    expect(overlay.keyframes).toEqual({
      x: [{ t: 0, value: 0.5 }],
      opacity: [{ t: 0, value: 0.5 }],
    });
  });
});

describe('usesPixelLayoutForProject', () => {
  it('treats projects older than the current schema as pixel layout', () => {
    expect(usesPixelLayoutForProject(undefined)).toBe(true);
    expect(usesPixelLayoutForProject(PROJECT_SCHEMA_VERSION)).toBe(false);
  });
});
