import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import { createDefaultTracks } from './trackModel';
import { planAddClip } from './planAddClip';

function makeClip(id: string, fileName = `${id}.mp4`): Clip {
  const file = new File(['x'], fileName, { type: 'video/mp4' });
  return {
    id,
    file,
    objectUrl: `blob:${id}`,
    title: fileName,
    kind: 'video',
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('planAddClip', () => {
  it('appends a new clip and track placement when filenames do not match', () => {
    const tracks = createDefaultTracks();
    const clip = makeClip('a');
    const plan = planAddClip([], tracks, [], clip);

    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0].id).toBe('a');
    expect(plan.tracks).toBeDefined();
    const videoTrack = plan.tracks!.find((t) => t.kind === 'video');
    expect(videoTrack?.items.some((item) => item.clipId === 'a')).toBe(true);
    expect(plan.clipGroups).toBeUndefined();
  });

  it('creates an A/B group when filenames match an edited suffix', () => {
    const tracks = createDefaultTracks();
    const first = makeClip('a', 'shot.mp4');
    const second = makeClip('b', 'shot_edited.mp4');
    const plan = planAddClip([first], tracks, [], second);

    expect(plan.clips).toHaveLength(2);
    expect(plan.clipGroups).toHaveLength(1);
    expect(plan.clipGroups![0].variants.A?.id).toBe('a');
    expect(plan.clipGroups![0].variants.B?.id).toBe('b');
    expect(plan.tracks).toBeUndefined();
  });
});
