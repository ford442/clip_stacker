import { describe, it, expect } from 'vitest';
import type { Clip, TextOverlay } from '../types';
import {
  canCaptureWebGpuCanvasWithText,
  canUseGpuVideoEncoder,
  clipNeedsEffects,
  needsMultiLayerComposition,
  needsOverlayPass,
  remoteConcatBlockers,
  shouldUseTimelineGpuExport,
} from './renderEligibility';
import { DEFAULT_FINISHING } from './finishing';

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
  describe('clipNeedsEffects', () => {
    it('is false for a clean clip with loopCount 1 (or omitted)', () => {
      expect(clipNeedsEffects(makeClip())).toBe(false);
      expect(clipNeedsEffects(makeClip({ loopCount: 1 }))).toBe(false);
    });

    it('is true when loopCount > 1', () => {
      expect(clipNeedsEffects(makeClip({ loopCount: 4 }))).toBe(true);
    });

    it('is true when the clip plays backward', () => {
      expect(clipNeedsEffects(makeClip({ reversed: true }))).toBe(true);
    });
  });

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

    it('is true for looped clips (must not use the loop-unaware sequential WebCodecs path)', () => {
      expect(needsMultiLayerComposition([makeClip({ loopCount: 4 })], [])).toBe(true);
    });

    it('is true when playback rate is not 1× so export samples remapped source time', () => {
      expect(needsMultiLayerComposition([makeClip({ playbackRate: 2 })], [])).toBe(true);
      expect(needsMultiLayerComposition([makeClip({ playbackRate: 1 })], [])).toBe(false);
      expect(
        needsMultiLayerComposition(
          [
            makeClip({
              automation: {
                playbackRate: [
                  { t: 0, value: 1 },
                  { t: 2, value: 2 },
                ],
              },
            }),
          ],
          [],
        ),
      ).toBe(true);
    });

    it('is true for a reversed clip so export does not walk the trim forward', () => {
      expect(needsMultiLayerComposition([makeClip({ reversed: true })], [])).toBe(true);
    });

    it('is false for a clip with loopCount 1', () => {
      expect(needsMultiLayerComposition([makeClip({ loopCount: 1 })], [])).toBe(false);
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

  describe('canCaptureWebGpuCanvasWithText', () => {
    it('is true with no overlays', () => {
      expect(canCaptureWebGpuCanvasWithText([])).toBe(true);
    });

    it('is true for shader-only overlays without boxes', () => {
      expect(
        canCaptureWebGpuCanvasWithText([
          solidOverlay({ fill: 'shader', shaderId: 'gradient' }),
        ]),
      ).toBe(true);
    });

    it('is false for solid text or boxed shader text', () => {
      expect(canCaptureWebGpuCanvasWithText([solidOverlay()])).toBe(false);
      expect(
        canCaptureWebGpuCanvasWithText([
          solidOverlay({ fill: 'shader', shaderId: 'gradient', box: true }),
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

describe('remoteConcatBlockers (allow-list)', () => {
  const plain = {
    transitions: [],
    textOverlays: [],
    finishing: DEFAULT_FINISHING,
    captionCount: 0,
    hasMasterAudio: false,
    needsAudioPremix: false,
  };

  it('allows a plain base-lane concat', () => {
    expect(remoteConcatBlockers([makeClip(), makeClip({ id: 'b', trimStart: 1, trimEnd: 3 })], plain)).toEqual([]);
  });

  it('refuses when a base clip sits on a muted lane', () => {
    const muted = makeClip({ id: 'm', trackMuted: true });
    expect(remoteConcatBlockers([makeClip(), muted], plain)).toEqual(['lane mute']);
  });

  it('lists overlays, transitions and captions', () => {
    expect(
      remoteConcatBlockers([makeClip({ layerIndex: 1 })], {
        ...plain,
        transitions: [{ afterClipIndex: 1, type: 'fade', duration: 1 }],
        captionCount: 2,
      }),
    ).toEqual(['PiP/overlay lanes', 'transitions', 'captions']);
  });

  it.each<[string, Partial<Clip>, string]>([
    ['audio-lane clip', { kind: 'audio' }, 'audio clips / audio lanes'],
    ['fade', { videoFadeIn: 0.5 }, 'fades'],
    ['audio fade', { audioFadeOut: 0.5 }, 'fades'],
    ['volume', { volume: 0.5 }, 'clip volume'],
    ['pan automation', { automation: { pan: [{ t: 0, value: -1 }] } }, 'volume / pan / speed automation'],
    [
      'clip insert',
      { audioEffects: { compressor: { enabled: true, thresholdDb: -20, ratio: 4, attack: 0.01, release: 0.1, kneeDb: 6, makeupDb: 0 } } } as Partial<Clip>,
      'clip audio inserts',
    ],
    ['constant speed', { playbackRate: 2 }, 'speed changes'],
    ['speed curve', { automation: { playbackRate: [{ t: 0, value: 1 }, { t: 1, value: 2 }] } }, 'speed changes'],
    ['reverse', { reversed: true }, 'reversed clips'],
    ['loop', { loopCount: 2 }, 'loops'],
    ['stabilize toggle', { stabilize: true }, 'stabilization'],
    ['rotation', { keyframes: { rotation: [{ t: 0, value: 90 }] } }, 'picture transforms'],
    ['still image', { stillImage: true }, 'still images'],
    ['opacity', { opacity: 0.5 }, 'clip opacity'],
  ])('refuses a clip with %s', (_name, overrides, label) => {
    expect(remoteConcatBlockers([makeClip(overrides)], plain)).toContain(label);
  });

  it('refuses master audio, finishing, titles and any audio premix', () => {
    const blockers = remoteConcatBlockers([makeClip()], {
      ...plain,
      textOverlays: [
        { id: 't', text: 'x', fontsize: 10, fontcolor: 'white', x: 0, y: 0, scrolling: false, scrollSpeed: 0, box: false, boxColor: 'black' },
      ],
      finishing: { ...DEFAULT_FINISHING, lut: { enabled: true, lutId: 'x', intensity: 1 } },
      hasMasterAudio: true,
      needsAudioPremix: true,
    });
    expect(blockers).toEqual([
      'text overlays',
      'finishing',
      'master audio',
      'the audio mix (automation, inserts, bus FX, loudness or audio lanes)',
    ]);
  });
});
