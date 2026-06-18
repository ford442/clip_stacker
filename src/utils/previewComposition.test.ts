import { describe, it, expect } from 'vitest';
import type { Clip, ClipGroup, ClipTransition, TextOverlay } from '../types';
import {
  buildClipTimelineSegments,
  buildPreviewCompositionPlan,
  filterBaseLayerTransitions,
} from './previewComposition';
import { getTimelineClips } from './timelineClips';

function makeClip(
  id: string,
  duration: number,
  overrides: Partial<Clip> = {},
): Clip {
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

function clipLayers(plan: ReturnType<typeof buildPreviewCompositionPlan>) {
  return plan.layers.filter((layer) => layer.kind === 'base' || layer.kind === 'pip');
}

describe('previewComposition', () => {
  describe('buildClipTimelineSegments', () => {
    it('lays out hard-cut clips sequentially', () => {
      const clips = [makeClip('a', 5), makeClip('b', 3)];
      const segments = buildClipTimelineSegments(clips, [], [0, 1]);

      expect(segments.map((segment) => segment.startTime)).toEqual([0, 5]);
      expect(segments.map((segment) => segment.endTime)).toEqual([5, 8]);
    });

    it('overlaps clips during dissolve transitions', () => {
      const clips = [makeClip('a', 5), makeClip('b', 3)];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
      ];
      const segments = buildClipTimelineSegments(clips, transitions, [0, 1]);

      expect(segments[0].startTime).toBe(0);
      expect(segments[1].startTime).toBe(4.5);
      expect(segments[1].endTime).toBe(7.5);
    });
  });

  describe('buildPreviewCompositionPlan', () => {
    it('returns an empty plan for an empty timeline', () => {
      const plan = buildPreviewCompositionPlan([], [], [], [], undefined, 0);

      expect(plan.isEmpty).toBe(true);
      expect(plan.layers).toEqual([]);
      expect(plan.totalDuration).toBe(0);
    });

    it('shows a single base clip during a hard-cut segment', () => {
      const clips = [makeClip('a', 5), makeClip('b', 3), makeClip('c', 2)];
      const plan = buildPreviewCompositionPlan(clips, [], [], [], undefined, 6);

      const layers = clipLayers(plan);
      expect(layers).toHaveLength(1);
      expect(layers[0].clipId).toBe('b');
      expect(layers[0].kind).toBe('base');
      expect(layers[0].localElapsed).toBeCloseTo(1);
      expect(layers[0].sourceTime).toBeCloseTo(1);
    });

    it('matches sequential FFmpeg order for non-transition stacks', () => {
      const clips = [makeClip('a', 4), makeClip('b', 4), makeClip('c', 4)];

      const first = buildPreviewCompositionPlan(clips, [], [], [], undefined, 1);
      const second = buildPreviewCompositionPlan(clips, [], [], [], undefined, 5);
      const third = buildPreviewCompositionPlan(clips, [], [], [], undefined, 9);

      expect(clipLayers(first).map((layer) => layer.clipId)).toEqual(['a']);
      expect(clipLayers(second).map((layer) => layer.clipId)).toEqual(['b']);
      expect(clipLayers(third).map((layer) => layer.clipId)).toEqual(['c']);
    });

    it('exposes both clips during a dissolve overlap window', () => {
      const clips = [makeClip('a', 5), makeClip('b', 3)];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
      ];
      const plan = buildPreviewCompositionPlan(
        clips,
        [],
        transitions,
        [],
        undefined,
        4.75,
      );

      const layers = clipLayers(plan);
      expect(layers).toHaveLength(2);
      expect(layers[0].clipId).toBe('a');
      expect(layers[1].clipId).toBe('b');
      expect(layers[0].crossfade?.role).toBe('outgoing');
      expect(layers[1].crossfade?.role).toBe('incoming');
      expect(layers[1].crossfade?.progress).toBeCloseTo(0.5);
      expect(layers[0].opacity).toBeCloseTo(0.5);
      expect(layers[1].opacity).toBeCloseTo(0.5);
    });

    it('draws PiP overlays above the base layer with a PiP rect', () => {
      const clips = [
        makeClip('base', 10),
        makeClip('pip', 4, {
          layerIndex: 1,
          x: 12,
          y: 24,
          width: 320,
          height: 180,
        }),
      ];
      const plan = buildPreviewCompositionPlan(clips, [], [], [], undefined, 2);

      const layers = clipLayers(plan);
      expect(layers).toHaveLength(2);
      expect(layers[0].clipId).toBe('base');
      expect(layers[1].clipId).toBe('pip');
      expect(layers[1].kind).toBe('pip');
      expect(layers[1].zIndex).toBeGreaterThan(layers[0].zIndex);
      expect(layers[1].rect).toEqual({
        x: 12,
        y: 24,
        width: 320,
        height: 180,
      });
      expect(layers[1].localElapsed).toBeCloseTo(2);
    });

    it('respects trim boundaries when seeking source media', () => {
      const clips = [
        makeClip('trimmed', 10, {
          trimStart: 2,
          trimEnd: 7,
        }),
      ];
      const plan = buildPreviewCompositionPlan(clips, [], [], [], undefined, 1.5);

      const layer = clipLayers(plan)[0];
      expect(layer.localElapsed).toBeCloseTo(1.5);
      expect(layer.clipDuration).toBeCloseTo(5);
      expect(layer.sourceTime).toBeCloseTo(3.5);
    });

    it('omits clip layers outside the output duration', () => {
      const clips = [makeClip('a', 3)];
      const before = buildPreviewCompositionPlan(clips, [], [], [], undefined, -1);
      const after = buildPreviewCompositionPlan(clips, [], [], [], undefined, 4);

      expect(before.layers).toEqual([]);
      expect(after.layers).toEqual([]);
    });

    it('includes text overlay slots above video layers', () => {
      const clips = [makeClip('a', 4)];
      const overlays: TextOverlay[] = [
        {
          id: 'text-1',
          text: 'Headline',
          fontsize: 40,
          fontcolor: 'white',
          x: 40,
          y: 600,
          scrolling: false,
          scrollSpeed: 20,
          box: false,
          boxColor: 'black@0.5',
        },
      ];
      const plan = buildPreviewCompositionPlan(
        clips,
        [],
        [],
        overlays,
        undefined,
        1,
      );

      expect(plan.layers).toHaveLength(2);
      expect(plan.layers[0].kind).toBe('base');
      expect(plan.layers[1].kind).toBe('text');
      expect(plan.layers[1].x).toBe(40);
    });

    it('resolves A/B groups through getTimelineClips before planning', () => {
      const clipA = makeClip('a', 5, { groupId: 'g1', groupVariant: 'A' });
      const clipB = makeClip('b', 5, { groupId: 'g1', groupVariant: 'B' });
      const groups: ClipGroup[] = [
        {
          id: 'g1',
          variants: { A: clipA, B: clipB },
          activeVariant: 'B',
        },
      ];
      const timelineClips = getTimelineClips([clipA, clipB], groups);
      expect(timelineClips.map((clip) => clip.id)).toEqual(['b']);

      const plan = buildPreviewCompositionPlan(
        [clipA, clipB],
        groups,
        [],
        [],
        undefined,
        1,
      );
      expect(clipLayers(plan)[0].clipId).toBe('b');
    });
  });

  describe('filterBaseLayerTransitions', () => {
    it('keeps only transitions between adjacent base clips', () => {
      const clips = [
        makeClip('a', 5),
        makeClip('b', 3),
        makeClip('pip', 4, { layerIndex: 1 }),
      ];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
        { afterClipIndex: 2, type: 'dissolve', duration: 0.25 },
      ];

      expect(filterBaseLayerTransitions(clips, transitions)).toEqual([
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
      ]);
    });

    it('drops transitions separated by a PiP clip', () => {
      const clips = [
        makeClip('a', 5),
        makeClip('pip', 4, { layerIndex: 1 }),
        makeClip('b', 3),
      ];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 2, type: 'dissolve', duration: 0.25 },
      ];

      expect(filterBaseLayerTransitions(clips, transitions)).toEqual([]);
    });
  });
});
