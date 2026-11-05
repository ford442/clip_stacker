import { describe, it, expect } from 'vitest';
import type { Clip, MasterAudio, Track } from '../types';
import {
  autoCutFromReference,
  autoCutToMusic,
  canAutoCutToMusic,
  resolveClipAutoCutReference,
  resolveMasterAutoCutReference,
} from './autoEdit';
import { createDefaultTracks, MAIN_VIDEO_TRACK_ID, setTrackLocked } from './trackModel';

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

function tracksWith(clipId: string): Track[] {
  const tracks = createDefaultTracks();
  tracks[0] = { ...tracks[0], items: [{ clipId, startTime: 0 }] };
  return tracks;
}

const masterAudio = (beats: number[], startTime = 0): MasterAudio => ({
  file: new File([], 'music.mp3'),
  objectUrl: 'blob:music',
  fileName: 'music.mp3',
  duration: 20,
  startTime,
  beatTimestamps: beats,
});

describe('autoCutToMusic', () => {
  const reference = makeClip('ref', 10, { beatTimestamps: [0, 1, 2, 3] });
  const broll = [makeClip('b1', 6), makeClip('b2', 6)];
  const clips = [reference, ...broll];

  it('cuts one segment per beat interval, alternating the B-roll', () => {
    const result = autoCutToMusic(tracksWith('ref'), clips, [], 'ref', ['b1', 'b2']);
    const main = result.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!;

    expect(main.items.map((i) => i.startTime)).toEqual([0, 1, 2]);
    const sources = main.items.map(
      (i) => result.clips.find((c) => c.id === i.clipId)!.title,
    );
    expect(sources).toEqual(['b1 (copy)', 'b2 (copy)', 'b1 (copy)']);
    expect(result.transitions).toEqual([
      { afterClipIndex: 1, type: 'none', duration: 0 },
      { afterClipIndex: 2, type: 'none', duration: 0 },
    ]);
  });

  it('leaves the source clips untouched', () => {
    const result = autoCutToMusic(tracksWith('ref'), clips, [], 'ref', ['b1']);
    expect(result.clips.slice(0, clips.length)).toEqual(clips);
    expect(result.clips.length).toBeGreaterThan(clips.length);
  });

  it('is a no-op when the reference has no beats or no B-roll is given', () => {
    const noBeats = makeClip('plain', 10);
    const tracks = tracksWith('plain');
    expect(autoCutToMusic(tracks, [noBeats, ...broll], [], 'plain', ['b1']).tracks).toEqual(
      tracks,
    );
    expect(autoCutToMusic(tracksWith('ref'), clips, [], 'ref', []).tracks).toEqual(
      tracksWith('ref'),
    );
    expect(canAutoCutToMusic(clips, 'ref')).toBe(true);
    expect(canAutoCutToMusic([noBeats], 'plain')).toBe(false);
  });

  it('refuses to rewrite a locked main lane', () => {
    const locked = setTrackLocked(tracksWith('ref'), MAIN_VIDEO_TRACK_ID, true);
    expect(autoCutToMusic(locked, clips, [], 'ref', ['b1']).tracks).toEqual(locked);
  });
});

describe('auto-cut references', () => {
  it('resolves a clip reference from its trimmed beat window', () => {
    const clip = makeClip('ref', 10, { beatTimestamps: [0, 1, 2, 3], trimStart: 1, trimEnd: 3 });
    expect(resolveClipAutoCutReference(tracksWith('ref'), [clip], [], 'ref')).toMatchObject({
      beats: [1, 2, 3],
      sourceOrigin: 1,
      outputStart: 0,
    });
  });

  it('returns null for a clip with fewer than two beats', () => {
    const clip = makeClip('ref', 10, { beatTimestamps: [2] });
    expect(resolveClipAutoCutReference(tracksWith('ref'), [clip], [], 'ref')).toBeNull();
    expect(resolveClipAutoCutReference(tracksWith('ref'), [], [], 'missing')).toBeNull();
  });

  it('resolves the master audio lane at its timeline offset', () => {
    expect(resolveMasterAutoCutReference(masterAudio([2, 1, 3], 4))).toMatchObject({
      beats: [1, 2, 3],
      sourceOrigin: 0,
      outputStart: 4,
    });
    expect(resolveMasterAutoCutReference(masterAudio([1]))).toBeNull();
    expect(resolveMasterAutoCutReference(null)).toBeNull();
  });

  it('places master-audio cuts at the lane offset plus the beat time', () => {
    const broll = makeClip('b1', 6);
    const result = autoCutFromReference(
      createDefaultTracks(),
      [broll],
      [],
      resolveMasterAutoCutReference(masterAudio([0, 1, 2], 4)),
      ['b1'],
    );
    const main = result.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!;
    expect(main.items.map((i) => i.startTime)).toEqual([4, 5]);
  });
});
