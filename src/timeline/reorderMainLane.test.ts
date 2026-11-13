import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  MAIN_VIDEO_TRACK_ID,
  migrateLegacyClipsToTracks,
  reorderMainLane,
} from './trackModel';

function makeClip(id: string, opts: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 4,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...opts,
  };
}

const laneIds = (tracks: ReturnType<typeof migrateLegacyClipsToTracks>) =>
  [...tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!.items]
    .sort((a, b) => a.startTime - b.startTime)
    .map((i) => i.clipId);

/** Main lane a b c d, with overlay clips interleaved in the pool. */
function fixture() {
  const clips = [
    makeClip('o1', { layerIndex: 1 }),
    makeClip('a'),
    makeClip('o2', { layerIndex: 1 }),
    makeClip('b'),
    makeClip('c'),
    makeClip('d'),
  ];
  return { clips, tracks: migrateLegacyClipsToTracks(clips, []) };
}

describe('reorderMainLane', () => {
  it.each([
    // [from, insertBefore, expected main-lane order]
    [0, 3, ['b', 'c', 'a', 'd']], // rightward, mid-lane
    [0, 4, ['b', 'c', 'd', 'a']], // to the end
    [3, 0, ['d', 'a', 'b', 'c']], // leftward to the start
    [2, 1, ['a', 'c', 'b', 'd']], // leftward by one
    [1, 3, ['a', 'c', 'b', 'd']], // rightward by one
  ])('moves %i before %i', (from, before, expected) => {
    const { tracks, clips } = fixture();
    const result = reorderMainLane(tracks, clips, [], from, before)!;
    expect(laneIds(result.tracks)).toEqual(expected);
    // The pool's main-lane clips follow the lane order.
    expect(result.clips.map((c) => c.id).filter((id) => !id.startsWith('o'))).toEqual(expected);
  });

  it('keeps overlay clips in their pool slots (indices are lane indices, not pool indices)', () => {
    const { tracks, clips } = fixture();
    const result = reorderMainLane(tracks, clips, [], 0, 3)!;
    // Pool slots 0 and 2 still hold the overlays; lane clips refill 1, 3, 4, 5.
    expect(result.clips.map((c) => c.id)).toEqual(['o1', 'b', 'o2', 'c', 'a', 'd']);
  });

  it('re-times the lane back to back after a reorder', () => {
    const { tracks, clips } = fixture();
    const result = reorderMainLane(tracks, clips, [], 3, 0)!;
    const starts = result.tracks
      .find((t) => t.id === MAIN_VIDEO_TRACK_ID)!
      .items.map((i) => i.startTime);
    expect(starts).toEqual([0, 4, 8, 12]);
  });

  it('returns null for identity and out-of-range moves', () => {
    const { tracks, clips } = fixture();
    expect(reorderMainLane(tracks, clips, [], 1, 1)).toBeNull();
    expect(reorderMainLane(tracks, clips, [], 1, 2)).toBeNull();
    expect(reorderMainLane(tracks, clips, [], 9, 0)).toBeNull();
  });

  it('leaves inactive A/B variants and unplaced clips where they were', () => {
    const clips = [makeClip('a'), makeClip('x', { layerIndex: 1 }), makeClip('b'), makeClip('c')];
    const tracks = migrateLegacyClipsToTracks(clips, []);
    const result = reorderMainLane(tracks, clips, [], 0, 3)!;
    expect(result.clips.map((c) => c.id)).toEqual(['b', 'x', 'c', 'a']);
  });
});
