import { describe, it, expect } from 'vitest';
import type { Clip, ClipGroup, ClipTransition } from '../types';
import {
  buildAudioSchedule,
  entriesActiveAtOrAfter,
} from './schedule';

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

describe('buildAudioSchedule', () => {
  it('lays out hard-cut base clips sequentially with no gap', () => {
    const clips = [makeClip('a', 5), makeClip('b', 3)];
    const schedule = buildAudioSchedule(clips, [], []);

    expect(schedule).toHaveLength(2);
    expect(schedule[0]).toMatchObject({
      clipId: 'a',
      timelineStart: 0,
      duration: 5,
      bufferOffset: 0,
    });
    expect(schedule[1]).toMatchObject({
      clipId: 'b',
      timelineStart: 5,
      duration: 3,
    });
    // Adjacent clips abut — no audible gap at the cut.
    expect(schedule[1].timelineStart).toBe(
      schedule[0].timelineStart + schedule[0].duration,
    );
  });

  it('overlaps clips during dissolve transitions', () => {
    const clips = [makeClip('a', 5), makeClip('b', 3)];
    const transitions: ClipTransition[] = [
      { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
    ];
    const schedule = buildAudioSchedule(clips, [], transitions);

    expect(schedule[0].timelineStart).toBe(0);
    expect(schedule[0].duration).toBe(5);
    expect(schedule[1].timelineStart).toBe(4.5);
    expect(schedule[1].duration).toBe(3);
  });

  it('respects trim as bufferOffset and duration', () => {
    const clips = [
      makeClip('a', 10, { trimStart: 2, trimEnd: 7, volume: 1.5 }),
    ];
    const schedule = buildAudioSchedule(clips, [], []);

    expect(schedule[0].bufferOffset).toBe(2);
    expect(schedule[0].duration).toBe(5);
    expect(schedule[0].volume).toBe(1.5);
  });

  it('clamps volume into 0–200%', () => {
    const clips = [makeClip('a', 2, { volume: 5 })];
    expect(buildAudioSchedule(clips, [], [])[0].volume).toBe(2);
  });

  it('schedules PiP overlays from output time 0', () => {
    const clips = [
      makeClip('base', 8),
      makeClip('pip', 3, { layerIndex: 1 }),
    ];
    const schedule = buildAudioSchedule(clips, [], []);
    const pip = schedule.find((e) => e.clipId === 'pip');
    expect(pip).toMatchObject({ timelineStart: 0, duration: 3 });
  });

  it('skips inactive A/B group variants', () => {
    const clipA = makeClip('a', 4, { groupId: 'g1', groupVariant: 'A' });
    const clipB = makeClip('b', 4, { groupId: 'g1', groupVariant: 'B' });
    const clipC = makeClip('c', 2);
    const clips = [clipA, clipB, clipC];
    const groups: ClipGroup[] = [
      {
        id: 'g1',
        activeVariant: 'A',
        variants: { A: clipA, B: clipB },
      },
    ];
    const schedule = buildAudioSchedule(clips, groups, []);
    expect(schedule.map((e) => e.clipId)).toEqual(['a', 'c']);
  });
});

describe('entriesActiveAtOrAfter', () => {
  it('filters finished clips', () => {
    const entries = buildAudioSchedule(
      [makeClip('a', 5), makeClip('b', 3)],
      [],
      [],
    );
    expect(entriesActiveAtOrAfter(entries, 0).map((e) => e.clipId)).toEqual([
      'a',
      'b',
    ]);
    expect(entriesActiveAtOrAfter(entries, 5).map((e) => e.clipId)).toEqual([
      'b',
    ]);
    expect(entriesActiveAtOrAfter(entries, 8)).toEqual([]);
  });
});
