import { describe, expect, it } from 'vitest';
import type { Clip, MasterAudio } from '../types';
import { createDefaultTracks } from './trackModel';
import {
  collectSnapTargets,
  DEFAULT_SNAP_THRESHOLD_SEC,
  snapClipStart,
  snapThresholdForZoom,
  snapTimelineTime,
} from './timelineSnap';

function makeClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: 4,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe('snapTimelineTime', () => {
  it('snaps to the playhead within the threshold', () => {
    expect(snapTimelineTime(5.06, { playhead: 5 })).toEqual({ time: 5, kind: 'playhead' });
    expect(snapTimelineTime(5.3, { playhead: 5 })).toEqual({ time: 5.3 });
  });

  it('snaps to a clip edge', () => {
    expect(snapTimelineTime(3.95, { itemEdges: [0, 4, 8] })).toEqual({ time: 4, kind: 'edge' });
  });

  it('snaps to a beat', () => {
    expect(snapTimelineTime(2.04, { beats: [1.5, 2, 2.5] })).toEqual({ time: 2, kind: 'beat' });
  });

  it('prefers the closest target, and the playhead on a tie', () => {
    expect(snapTimelineTime(2.03, { playhead: 1.95, beats: [2] })).toEqual({ time: 2, kind: 'beat' });
    expect(snapTimelineTime(2.05, { playhead: 2, itemEdges: [2], beats: [2] }))
      .toEqual({ time: 2, kind: 'playhead' });
    expect(snapTimelineTime(2.05, { itemEdges: [2], beats: [2] })).toEqual({ time: 2, kind: 'edge' });
  });

  it('honours a custom threshold', () => {
    expect(snapTimelineTime(5.3, { playhead: 5 }, 0.5)).toEqual({ time: 5, kind: 'playhead' });
  });
});

describe('snapClipStart', () => {
  it('snaps whichever clip edge is closer', () => {
    // Tail (6.97 + 2 = 8.97) is 0.03 from the 9s edge; head is 0.03 from nothing.
    expect(snapClipStart(6.97, 2, { itemEdges: [9] })).toEqual({ time: 7, kind: 'edge' });
    expect(snapClipStart(4.02, 2, { playhead: 4, itemEdges: [6.05] }))
      .toEqual({ time: 4, kind: 'playhead' });
  });

  it('leaves an unsnapped start alone', () => {
    expect(snapClipStart(3, 1, { itemEdges: [10] })).toEqual({ time: 3 });
  });
});

describe('snapThresholdForZoom', () => {
  it('never shrinks below the beat-snap tolerance', () => {
    expect(snapThresholdForZoom(1000)).toBe(DEFAULT_SNAP_THRESHOLD_SEC);
    expect(snapThresholdForZoom(20)).toBeCloseTo(0.4);
  });
});

describe('collectSnapTargets', () => {
  it('gathers edges, beats, markers and caption edges in output time', () => {
    const tracks = createDefaultTracks();
    tracks[1] = { ...tracks[1], items: [{ clipId: 'o', startTime: 5 }, { clipId: 'moving', startTime: 0 }] };
    const clips = [
      makeClip('o', { trimStart: 1, trimEnd: 5, beatTimestamps: [2, 3, 7] }),
      makeClip('moving'),
    ];
    const masterAudio = { startTime: 1, beatTimestamps: [0.5] } as MasterAudio;
    const targets = collectSnapTargets({
      tracks,
      clips,
      playhead: 2,
      captions: [{ id: 'c', startSec: 1, endSec: 2, text: 'hi' }],
      markers: [{ id: 'm', time: 7, text: '' }],
      masterAudio,
      excludeClipId: 'moving',
    });
    expect(targets.itemEdges).toEqual([5, 9]);
    // Clip beats inside the trim window map to output time; beat 7 is outside.
    expect(targets.beats).toEqual([6, 7, 1.5]);
    expect(targets.markers).toEqual([7]);
    expect(targets.captions).toEqual([1, 2]);
    expect(targets.playhead).toBe(2);
  });
});
