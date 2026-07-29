import { describe, it, expect } from 'vitest';
import type { Clip, TextOverlay } from '../types';
import {
  canUseGpuVideoEncoder,
  needsMultiLayerComposition,
  needsOverlayPass,
  shouldUseTimelineGpuExport,
} from './renderEligibility';

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

function solidOverlay(overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: 't1',
    text: 'Hi',
    fontsize: 24,
    fontcolor: 'white',
    x: 0,
    y: 0,
    scrolling: false,
    scrollSpeed: 20,
    box: false,
    boxColor: 'black@0.5',
    ...overrides,
  };
}

describe('renderEligibility', () => {
  describe('needsMultiLayerComposition', () => {
    it('is false for plain clip stacks', () => {
      expect(needsMultiLayerComposition([makeClip(), makeClip({ id: 'clip-2' })], [])).toBe(
        false,
      );
    });

    it('is true for active transitions', () => {
      expect(
        needsMultiLayerComposition(
          [makeClip()],
          [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }],
        ),
      ).toBe(true);
    });

    it('is true for PiP layers', () => {
      expect(needsMultiLayerComposition([makeClip({ layerIndex: 1 })], [])).toBe(true);
    });

    it('is true for clip keyframes', () => {
      expect(
        needsMultiLayerComposition(
          [
            makeClip({
              keyframes: {
                opacity: [
                  { t: 0, value: 1 },
                  { t: 2, value: 0.5 },
                ],
              },
            }),
          ],
          [],
        ),
      ).toBe(true);
    });

    it('is false when only text overlays have keyframes', () => {
      expect(
        needsMultiLayerComposition(
          [makeClip()],
          [],
        ),
      ).toBe(false);
      expect(
        shouldUseTimelineGpuExport(
          [makeClip()],
          [],
          [
            solidOverlay({
              keyframes: {
                x: [
                  { t: 0, value: 0 },
                  { t: 2, value: 100 },
                ],
              },
            }),
          ],
        ),
      ).toBe(false);
    });

    it('is true for still-image clips', () => {
      expect(needsMultiLayerComposition([makeClip({ stillImage: true })], [])).toBe(true);
    });
  });

  describe('needsOverlayPass', () => {
    it('is false with no overlays', () => {
      expect(needsOverlayPass([])).toBe(false);
    });

    it('is true for solid text overlays', () => {
      expect(needsOverlayPass([solidOverlay()])).toBe(true);
    });

    it('is false for shader-filled text overlays', () => {
      expect(
        needsOverlayPass([
          solidOverlay({ fill: 'shader', shaderId: 'gradient' }),
        ]),
      ).toBe(false);
    });
  });

  describe('shouldUseTimelineGpuExport', () => {
    it('keeps clips + solid text on the decoder path', () => {
      expect(shouldUseTimelineGpuExport([makeClip()], [], [solidOverlay()])).toBe(false);
    });

    it('routes shader-filled text to the timeline compositor', () => {
      expect(
        shouldUseTimelineGpuExport(
          [makeClip()],
          [],
          [solidOverlay({ fill: 'shader', shaderId: 'gradient' })],
        ),
      ).toBe(true);
    });

    it('still routes transitions to the timeline compositor', () => {
      expect(
        shouldUseTimelineGpuExport(
          [makeClip()],
          [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }],
          [solidOverlay()],
        ),
      ).toBe(true);
    });
  });

  it('allows GPU export for simple stacks', () => {
    expect(canUseGpuVideoEncoder([makeClip()], [], [])).toBe(true);
  });

  it('blocks GPU export for transitions when WebGPU is unavailable', () => {
    expect(
      canUseGpuVideoEncoder(
        [makeClip()],
        [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }],
        [],
      ),
    ).toBe(false);
    expect(
      canUseGpuVideoEncoder(
        [makeClip()],
        [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }],
        [],
        { webGpuAvailable: true },
      ),
    ).toBe(true);
    expect(canUseGpuVideoEncoder([makeClip({ layerIndex: 1 })], [], [])).toBe(false);
    expect(
      canUseGpuVideoEncoder([makeClip({ layerIndex: 1 })], [], [], {
        webGpuAvailable: true,
      }),
    ).toBe(true);
  });

  it('allows GPU timeline export when clip keyframes are present', () => {
    expect(
      canUseGpuVideoEncoder(
        [
          makeClip({
            keyframes: {
              opacity: [
                { t: 0, value: 1 },
                { t: 2, value: 0.5 },
              ],
            },
          }),
        ],
        [],
        [],
        { webGpuAvailable: true },
      ),
    ).toBe(true);
  });

  it('allows GPU decoder export for solid text overlays without WebGPU', () => {
    expect(canUseGpuVideoEncoder([makeClip()], [], [solidOverlay()])).toBe(true);
    expect(
      canUseGpuVideoEncoder([makeClip()], [], [solidOverlay()], { webGpuAvailable: true }),
    ).toBe(true);
  });

  it('requires WebGPU for shader-filled text overlays', () => {
    const shaderOverlay = solidOverlay({ fill: 'shader', shaderId: 'gradient' });
    expect(canUseGpuVideoEncoder([makeClip()], [], [shaderOverlay])).toBe(false);
    expect(
      canUseGpuVideoEncoder([makeClip()], [], [shaderOverlay], { webGpuAvailable: true }),
    ).toBe(true);
  });
});
