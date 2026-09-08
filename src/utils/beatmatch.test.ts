import { describe, expect, it } from 'vitest';
import type { Clip, MasterAudio, Track } from '../types';
import {
  buildBeatmatchTargets,
  clipBeatsAbs,
  clipItemStartTime,
  downbeatStartTime,
  masterBeatsAbs,
  snapStartToTargetBeat,
} from './beatmatch';
import { createTestClip } from './project.test.helpers';

function makeMaster(overrides: Partial<MasterAudio> = {}): MasterAudio {
  return {
    file: new File([], 'song.mp3', { type: 'audio/mpeg' }),
    objectUrl: 'blob:song',
    fileName: 'song.mp3',
    duration: 30,
    startTime: 0,
    ...overrides,
  };
}

function trackWith(items: Array<{ clipId: string; startTime: number }>): Track[] {
  return [{ id: 'v1', kind: 'video', items }];
}

describe('clipItemStartTime', () => {
  it('reads the placed start time, defaulting to 0', () => {
    const tracks = trackWith([{ clipId: 'a', startTime: 3.25 }]);
    expect(clipItemStartTime(tracks, 'a')).toBe(3.25);
    expect(clipItemStartTime(tracks, 'missing')).toBe(0);
  });
});

describe('clipBeatsAbs', () => {
  it('maps in-trim source beats through trim, rate and item start', () => {
    const clip: Clip = { ...createTestClip('a', 10), trimStart: 1, trimEnd: 5 };
    clip.beatTimestamps = [0.5, 1, 2, 3, 9];
    // 0.5 and 9 fall outside the trim window and are dropped.
    expect(clipBeatsAbs(clip, 2, 1)).toEqual([2, 3, 4]);
    // At 2x speed the trimmed span (and its beats) compress by half.
    expect(clipBeatsAbs(clip, 2, 2)).toEqual([2, 2.5, 3]);
  });
});

describe('masterBeatsAbs', () => {
  it('offsets beats by the master start time and drops out-of-range ones', () => {
    const master = makeMaster({
      startTime: 1,
      duration: 3,
      beatTimestamps: [0, 1, 2, 99],
    });
    expect(masterBeatsAbs(master)).toEqual([1, 2, 3]);
    expect(masterBeatsAbs(makeMaster())).toEqual([]);
    expect(masterBeatsAbs(null)).toEqual([]);
  });
});

describe('buildBeatmatchTargets', () => {
  it('lists master first, then other clips with a BPM', () => {
    const follower = createTestClip('a', 10);
    const other = createTestClip('b', 10, 'Other');
    other.bpmEstimate = 90;
    other.beatTimestamps = [0, 1, 2];
    const noBpm = createTestClip('c', 10, 'Silent');

    const targets = buildBeatmatchTargets(
      makeMaster({ bpmEstimate: 128, beatTimestamps: [0, 0.5] }),
      [follower, other, noBpm],
      trackWith([{ clipId: 'b', startTime: 4 }]),
      'a',
    );

    expect(targets.map((t) => t.id)).toEqual(['master', 'b']);
    expect(targets[0]!.bpm).toBe(128);
    expect(targets[1]!.beatsAbs).toEqual([4, 5, 6]);
  });

  it('prefers a clip BPM override and excludes the follower itself', () => {
    const follower = createTestClip('a', 10);
    follower.bpmEstimate = 100;
    const other = createTestClip('b', 10);
    other.bpmEstimate = 100;
    other.bpmOverride = 140;

    const targets = buildBeatmatchTargets(null, [follower, other], trackWith([]), 'a');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.bpm).toBe(140);
  });

  it('omits master audio that has no BPM', () => {
    const targets = buildBeatmatchTargets(makeMaster(), [], trackWith([]), null);
    expect(targets).toEqual([]);
  });
});

describe('downbeatStartTime', () => {
  const clip: Clip = { ...createTestClip('a', 10), trimStart: 0.25 };
  clip.beatTimestamps = [0.25, 0.75, 1.25];

  it('moves the clip so its first beat lands on the target downbeat', () => {
    const target = {
      id: 'master',
      label: 'Master',
      bpm: 120,
      beatsAbs: [2, 2.5, 3],
    };
    // First follower beat sits exactly at the item start, so it moves to 2s.
    expect(downbeatStartTime(clip, 0, 1, target)).toBeCloseTo(2, 6);
    // A later item start shifts by the same phase delta.
    expect(downbeatStartTime(clip, 5, 1, target)).toBeCloseTo(2, 6);
  });

  it('never produces a negative start time', () => {
    const target = { id: 'm', label: 'M', bpm: 120, beatsAbs: [0] };
    const late: Clip = { ...clip, trimStart: 0 };
    late.beatTimestamps = [4];
    expect(downbeatStartTime(late, 0, 1, target)).toBe(0);
  });

  it('returns null when either side has no beat', () => {
    const empty = { id: 'm', label: 'M', bpm: 120, beatsAbs: [] };
    expect(downbeatStartTime(clip, 0, 1, empty)).toBeNull();
    const beatless: Clip = { ...createTestClip('z', 10) };
    expect(
      downbeatStartTime(beatless, 0, 1, { id: 'm', label: 'M', bpm: 120, beatsAbs: [1] }),
    ).toBeNull();
  });
});

describe('snapStartToTargetBeat', () => {
  const target = { id: 'm', label: 'M', bpm: 120, beatsAbs: [0, 0.5, 1, 1.5] };

  it('snaps to the nearest target beat', () => {
    expect(snapStartToTargetBeat(0.9, target)).toBe(1);
  });

  it('is a no-op without a target or beats', () => {
    expect(snapStartToTargetBeat(0.9, null)).toBeNull();
    expect(snapStartToTargetBeat(0.9, { ...target, beatsAbs: [] })).toBeNull();
  });
});
