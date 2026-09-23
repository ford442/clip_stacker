import { describe, expect, it } from 'vitest';
import type { Clip, ClipTransition, Track } from '../types';
import {
  dropEdit,
  insertEdit,
  normalizeBaseLane,
  nudgeWithTool,
  overwriteEdit,
  remapBaseTransitions,
  rippleDelete,
  rippleTrim,
  rollEdit,
  slideClip,
  slipClip,
  type EditResult,
  type EditState,
} from './editModes';
import {
  addTrack,
  createDefaultTracks,
  MAIN_VIDEO_TRACK_ID,
  OVERLAY_VIDEO_TRACK_ID,
  setTrackLocked,
} from './trackModel';
import { buildClipTimelineSegments } from './previewCompositionSegments';
import { getClipDuration } from './project/clipHelpers';

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

/** A 10s source trimmed to [trimStart, trimStart + len). */
function trimmed(id: string, trimStart: number, len: number, overrides: Partial<Clip> = {}): Clip {
  return makeClip(id, 10, { trimStart, trimEnd: trimStart + len, ...overrides });
}

function overlayState(
  items: { id: string; start: number }[],
  clips: Clip[],
  transitions: ClipTransition[] = [],
): EditState {
  const tracks = createDefaultTracks();
  tracks[1] = {
    ...tracks[1],
    items: items.map((i) => ({ clipId: i.id, startTime: i.start })),
  };
  return { tracks, clips, transitions };
}

function baseState(clips: Clip[], transitions: ClipTransition[] = []): EditState {
  const tracks = createDefaultTracks();
  tracks[0] = {
    ...tracks[0],
    items: clips.map((c, i) => ({ clipId: c.id, startTime: i * 100 })),
  };
  return {
    tracks: normalizeBaseLane(tracks, clips, transitions),
    clips,
    transitions,
  };
}

function ok(result: EditResult): EditState {
  if (!result.ok) throw new Error(`expected edit to succeed: ${result.reason}`);
  return result.state;
}

function lane(state: EditState, trackId: string): [string, number][] {
  const track = state.tracks.find((t) => t.id === trackId)!;
  return [...track.items]
    .sort((a, b) => a.startTime - b.startTime)
    .map((i) => [i.clipId, Number(i.startTime.toFixed(4))]);
}

function clip(state: EditState, id: string): Clip {
  return state.clips.find((c) => c.id === id)!;
}

function lockLane(state: EditState, trackId: string): EditState {
  return { ...state, tracks: setTrackLocked(state.tracks, trackId, true) };
}

const dissolve = (afterClipIndex: number, duration = 1): ClipTransition => ({
  afterClipIndex,
  type: 'dissolve',
  duration,
});

describe('overwriteEdit', () => {
  it('covers straddling items without moving anything later', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 4 }, { id: 'z', start: 10 }],
      [trimmed('x', 0, 4), trimmed('y', 0, 4), trimmed('z', 0, 2), trimmed('n', 0, 2)],
    );
    const next = ok(overwriteEdit(state, 'n', OVERLAY_VIDEO_TRACK_ID, 3));
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([
      ['x', 0], ['n', 3], ['y', 5], ['z', 10],
    ]);
    expect(clip(next, 'x').trimEnd).toBeCloseTo(3);
    expect(clip(next, 'y').trimStart).toBeCloseTo(1);
    expect(getClipDuration(clip(next, 'y'))).toBeCloseTo(3);
  });

  it('splits an item the drop lands inside, duplicating the placement not the media', () => {
    const state = overlayState([{ id: 'x', start: 0 }], [trimmed('x', 0, 6), trimmed('n', 0, 2)]);
    const next = ok(overwriteEdit(state, 'n', OVERLAY_VIDEO_TRACK_ID, 2));
    const items = lane(next, OVERLAY_VIDEO_TRACK_ID);
    expect(items.map(([, t]) => t)).toEqual([0, 2, 4]);
    const tail = clip(next, items[2][0]);
    expect(tail.id).not.toBe('x');
    expect(tail.file).toBe(clip(state, 'x').file);
    expect(tail.trimStart).toBeCloseTo(4);
    expect(tail.trimEnd).toBeCloseTo(6);
    expect(clip(next, 'x').trimEnd).toBeCloseTo(2);
  });

  it('removes placements it fully covers', () => {
    const state = overlayState(
      [{ id: 'x', start: 1 }, { id: 'y', start: 2 }],
      [trimmed('x', 0, 1), trimmed('y', 0, 1), trimmed('n', 0, 4)],
    );
    const next = ok(overwriteEdit(state, 'n', OVERLAY_VIDEO_TRACK_ID, 0));
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['n', 0]]);
    expect(next.clips.map((c) => c.id)).toEqual(['n']);
  });

  it('refuses a locked target lane', () => {
    const state = overlayState([], [trimmed('n', 0, 2)]);
    const result = overwriteEdit(lockLane(state, OVERLAY_VIDEO_TRACK_ID), 'n', OVERLAY_VIDEO_TRACK_ID, 0);
    expect(result.ok).toBe(false);
  });

  it('refuses a video clip on an audio lane', () => {
    const state = overlayState([], [trimmed('n', 0, 2)]);
    expect(overwriteEdit(state, 'n', 'a1', 0).ok).toBe(false);
  });
});

describe('insertEdit', () => {
  it('pushes later items on the lane right by the clip length', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 4 }],
      [trimmed('x', 0, 4), trimmed('y', 0, 4), trimmed('n', 0, 2)],
    );
    const next = ok(insertEdit(state, 'n', OVERLAY_VIDEO_TRACK_ID, 4));
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['n', 4], ['y', 6]]);
    expect(clip(next, 'y')).toBe(clip(state, 'y'));
  });

  it('splits the item under the insert point and ripples its tail', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 4 }],
      [trimmed('x', 0, 4), trimmed('y', 0, 4), trimmed('n', 0, 2)],
    );
    const next = ok(insertEdit(state, 'n', OVERLAY_VIDEO_TRACK_ID, 1));
    const items = lane(next, OVERLAY_VIDEO_TRACK_ID);
    expect(items.map(([, t]) => t)).toEqual([0, 1, 3, 6]);
    expect(items[1][0]).toBe('n');
    expect(clip(next, items[2][0]).trimStart).toBeCloseTo(1);
    expect(clip(next, 'x').trimEnd).toBeCloseTo(1);
  });

  it('is lane-local by default — other lanes do not move', () => {
    let state = overlayState(
      [{ id: 'x', start: 0 }],
      [trimmed('x', 0, 4), trimmed('n', 0, 2), trimmed('z', 0, 1)],
    );
    state = { ...state, tracks: addTrack(state.tracks, 'video') };
    const v3 = state.tracks.find((t) => t.kind === 'video' && t.id !== MAIN_VIDEO_TRACK_ID && t.id !== OVERLAY_VIDEO_TRACK_ID)!;
    state = {
      ...state,
      tracks: state.tracks.map((t) => (t.id === v3.id ? { ...t, items: [{ clipId: 'z', startTime: 5 }] } : t)),
    };
    const local = ok(insertEdit(state, 'n', OVERLAY_VIDEO_TRACK_ID, 4));
    expect(lane(local, v3.id)).toEqual([['z', 5]]);

    const linked = ok(insertEdit(state, 'n', OVERLAY_VIDEO_TRACK_ID, 4, { linked: true }));
    expect(lane(linked, v3.id)).toEqual([['z', 7]]);

    // A locked neighbour lane that the linked ripple would have to move blocks it…
    const locked = lockLane(state, v3.id);
    expect(insertEdit(locked, 'n', OVERLAY_VIDEO_TRACK_ID, 4, { linked: true }).ok).toBe(false);
    // …but a lane-local insert never touches it.
    expect(insertEdit(locked, 'n', OVERLAY_VIDEO_TRACK_ID, 4).ok).toBe(true);
  });

  it('dropEdit dispatches on mode', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 4 }],
      [trimmed('x', 0, 4), trimmed('y', 0, 4), trimmed('n', 0, 2)],
    );
    expect(lane(ok(dropEdit(state, 'insert', 'n', OVERLAY_VIDEO_TRACK_ID, 4)), OVERLAY_VIDEO_TRACK_ID))
      .toEqual([['x', 0], ['n', 4], ['y', 6]]);
    expect(lane(ok(dropEdit(state, 'overwrite', 'n', OVERLAY_VIDEO_TRACK_ID, 4)), OVERLAY_VIDEO_TRACK_ID))
      .toEqual([['x', 0], ['n', 4], ['y', 6]]);
    expect(clip(ok(dropEdit(state, 'overwrite', 'n', OVERLAY_VIDEO_TRACK_ID, 4)), 'y').trimStart)
      .toBeCloseTo(2);
  });
});

describe('rippleDelete', () => {
  it('closes the gap on the lane', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 2 }, { id: 'z', start: 5 }],
      [trimmed('x', 0, 2), trimmed('y', 0, 3), trimmed('z', 0, 1)],
    );
    const next = ok(rippleDelete(state, 'y'));
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['z', 2]]);
    expect(next.clips.some((c) => c.id === 'y')).toBe(false);
  });

  it('re-keys base-lane transitions to the pairs that survive', () => {
    const clips = [trimmed('a', 0, 4), trimmed('b', 0, 4), trimmed('c', 0, 4), trimmed('d', 0, 4)];
    const state = baseState(clips, [dissolve(1), dissolve(3, 0.5)]);
    const next = ok(rippleDelete(state, 'b'));
    expect(lane(next, MAIN_VIDEO_TRACK_ID).map(([id]) => id)).toEqual(['a', 'c', 'd']);
    // a→b is gone; c→d moves from slot 3 to slot 2.
    expect(next.transitions).toEqual([dissolve(2, 0.5)]);
    expect(lane(next, MAIN_VIDEO_TRACK_ID).map(([, t]) => t)).toEqual([0, 4, 7.5]);
  });

  it('refuses on a locked lane', () => {
    const state = overlayState([{ id: 'x', start: 0 }], [trimmed('x', 0, 2)]);
    expect(rippleDelete(lockLane(state, OVERLAY_VIDEO_TRACK_ID), 'x').ok).toBe(false);
  });
});

describe('rippleTrim', () => {
  it('extends the out-point and pushes later items', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 2 }],
      [trimmed('x', 0, 2), trimmed('y', 0, 2)],
    );
    const next = ok(rippleTrim(state, 'x', 'out', 1));
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['y', 3]]);
    expect(clip(next, 'x').trimEnd).toBeCloseTo(3);
  });

  it('trimming the in-point later pulls later items left', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 2 }],
      [trimmed('x', 0, 2), trimmed('y', 0, 2)],
    );
    const next = ok(rippleTrim(state, 'x', 'in', 0.5));
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['y', 1.5]]);
  });
});

describe('rollEdit', () => {
  const pair = () =>
    overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 4 }],
      [trimmed('x', 0, 4), trimmed('y', 2, 4)],
    );

  it('moves A out and B in together', () => {
    const next = ok(rollEdit(pair(), 'x', 1));
    expect(clip(next, 'x').trimEnd).toBeCloseTo(5);
    expect(clip(next, 'y').trimStart).toBeCloseTo(3);
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['y', 5]]);
    // The pair's combined span is unchanged.
    expect(getClipDuration(clip(next, 'x')) + getClipDuration(clip(next, 'y'))).toBeCloseTo(8);
  });

  it('converts output time to source time with the playback rate', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 2 }],
      [trimmed('x', 0, 4, { playbackRate: 2 }), trimmed('y', 2, 4, { playbackRate: 2 })],
    );
    const next = ok(rollEdit(state, 'x', 1));
    expect(clip(next, 'x').trimEnd).toBeCloseTo(6);
    expect(clip(next, 'y').trimStart).toBeCloseTo(4);
  });

  it('refuses to run past the source media', () => {
    expect(rollEdit(pair(), 'x', -2.5).ok).toBe(false);
    expect(rollEdit(pair(), 'x', 7).ok).toBe(false);
  });

  it('refuses when the clips do not touch', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 5 }],
      [trimmed('x', 0, 4), trimmed('y', 2, 4)],
    );
    expect(rollEdit(state, 'x', 1).ok).toBe(false);
  });

  it('refuses a speed-ramped clip rather than trimming it approximately', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 4 }],
      [
        trimmed('x', 0, 4, { automation: { playbackRate: [{ t: 0, value: 1 }, { t: 2, value: 2 }] } } as Partial<Clip>),
        trimmed('y', 2, 4),
      ],
    );
    expect(rollEdit(state, 'x', 1).ok).toBe(false);
  });

  it('keeps base-lane start times in sync with transition-aware segment math', () => {
    const clips = [trimmed('a', 0, 4), trimmed('b', 2, 4), trimmed('c', 0, 4)];
    const transitions = [dissolve(1), dissolve(2)];
    const state = baseState(clips, transitions);
    const before = lane(state, MAIN_VIDEO_TRACK_ID);
    expect(before).toEqual([['a', 0], ['b', 3], ['c', 6]]);

    const next = ok(rollEdit(state, 'a', 0.5));
    const ordered = ['a', 'b', 'c'].map((id) => clip(next, id));
    const segments = buildClipTimelineSegments(ordered, next.transitions, [0, 1, 2]);
    expect(lane(next, MAIN_VIDEO_TRACK_ID)).toEqual(
      segments.map((s) => [s.clip.id, Number(s.startTime.toFixed(4))]),
    );
    // The edit moved; everything after the pair did not.
    expect(lane(next, MAIN_VIDEO_TRACK_ID)).toEqual([['a', 0], ['b', 3.5], ['c', 6]]);
    expect(next.transitions).toBe(state.transitions);
  });

  it('refuses a base-lane roll that would make a clip shorter than its xfades', () => {
    const clips = [trimmed('a', 0, 4), trimmed('b', 2, 4), trimmed('c', 0, 4)];
    const state = baseState(clips, [dissolve(1, 1.5), dissolve(2, 1.5)]);
    // b would be 1s long with 3s of xfades on it.
    expect(rollEdit(state, 'a', 3).ok).toBe(false);
  });
});

describe('slipClip', () => {
  it('moves the source window but not the timeline position', () => {
    const state = overlayState([{ id: 'x', start: 3 }], [trimmed('x', 2, 4)]);
    const next = ok(slipClip(state, 'x', 1.5));
    expect(clip(next, 'x').trimStart).toBeCloseTo(3.5);
    expect(clip(next, 'x').trimEnd).toBeCloseTo(7.5);
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 3]]);
  });

  it('refuses to slip past either end of the source', () => {
    const state = overlayState([{ id: 'x', start: 0 }], [trimmed('x', 2, 4)]);
    expect(slipClip(state, 'x', -3).ok).toBe(false);
    expect(slipClip(state, 'x', 5).ok).toBe(false);
  });
});

describe('slideClip', () => {
  const trio = () =>
    overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 3 }, { id: 'z', start: 5 }],
      [trimmed('x', 0, 3), trimmed('y', 0, 2), trimmed('z', 2, 3)],
    );

  it('moves the clip while neighbours absorb the change', () => {
    const next = ok(slideClip(trio(), 'y', 1));
    expect(lane(next, OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['y', 4], ['z', 6]]);
    expect(clip(next, 'x').trimEnd).toBeCloseTo(4);
    expect(clip(next, 'y').trimStart).toBe(0);
    expect(clip(next, 'z').trimStart).toBeCloseTo(3);
    // Group end (z out) is unchanged.
    expect(6 + getClipDuration(clip(next, 'z'))).toBeCloseTo(8);
  });

  it('uses up a gap instead of a neighbour on an overlay lane', () => {
    const state = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 4 }],
      [trimmed('x', 0, 3), trimmed('y', 0, 2)],
    );
    expect(lane(ok(slideClip(state, 'y', -1)), OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['y', 3]]);
    // Only 1s of gap to use up — any further would overlap x.
    expect(slideClip(state, 'y', -1.5).ok).toBe(false);
  });

  it('needs a clip on each side on the main lane', () => {
    const state = baseState([trimmed('a', 0, 4), trimmed('b', 2, 4)]);
    expect(slideClip(state, 'a', 1).ok).toBe(false);
  });

  it('slides a middle base clip without changing the sequence length', () => {
    const clips = [trimmed('a', 0, 4), trimmed('b', 2, 4), trimmed('c', 2, 4)];
    const state = baseState(clips, [dissolve(1)]);
    const next = ok(slideClip(state, 'b', 1));
    const ordered = ['a', 'b', 'c'].map((id) => clip(next, id));
    const durations = ordered.map(getClipDuration);
    expect(durations[0] + durations[1] + durations[2]).toBeCloseTo(12);
    expect(lane(next, MAIN_VIDEO_TRACK_ID)).toEqual([['a', 0], ['b', 4], ['c', 8]]);
  });
});

describe('lock guards', () => {
  const state = () =>
    overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 3 }, { id: 'z', start: 5 }],
      [trimmed('x', 0, 3), trimmed('y', 0, 2), trimmed('z', 2, 3), trimmed('n', 0, 1)],
    );

  it('blocks every edit on a locked lane', () => {
    const locked = lockLane(state(), OVERLAY_VIDEO_TRACK_ID);
    const results = [
      overwriteEdit(locked, 'n', OVERLAY_VIDEO_TRACK_ID, 0),
      insertEdit(locked, 'n', OVERLAY_VIDEO_TRACK_ID, 0),
      rippleDelete(locked, 'y'),
      rippleTrim(locked, 'y', 'out', 0.5),
      rollEdit(locked, 'x', 0.5),
      slipClip(locked, 'y', 0.5),
      slideClip(locked, 'y', 0.5),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/locked/);
    }
  });

  it('a linked ripple is blocked by a locked neighbour lane with items after the edit', () => {
    let s = state();
    s = { ...s, tracks: addTrack(s.tracks, 'video') };
    const v3 = s.tracks.filter((t) => t.kind === 'video')[2];
    s = {
      ...s,
      clips: [...s.clips, trimmed('w', 0, 1)],
      tracks: s.tracks.map((t) => (t.id === v3.id ? { ...t, items: [{ clipId: 'w', startTime: 6 }] } : t)),
    };
    const locked = lockLane(s, v3.id);
    expect(rippleTrim(locked, 'y', 'out', 0.5, { linked: true }).ok).toBe(false);
    expect(rippleDelete(locked, 'y', { linked: true }).ok).toBe(false);
    expect(rippleTrim(locked, 'y', 'out', 0.5).ok).toBe(true);
  });

  it('refuses to lift a clip off a locked source lane', () => {
    const s = state();
    const tracks: Track[] = s.tracks.map((t) =>
      t.id === MAIN_VIDEO_TRACK_ID ? { ...t, items: [{ clipId: 'n', startTime: 0 }], locked: true } : t,
    );
    expect(overwriteEdit({ ...s, tracks }, 'n', OVERLAY_VIDEO_TRACK_ID, 10).ok).toBe(false);
  });
});

describe('nudgeWithTool', () => {
  it('routes each tool to its edit', () => {
    const s = overlayState(
      [{ id: 'x', start: 0 }, { id: 'y', start: 3 }],
      [trimmed('x', 0, 3), trimmed('y', 1, 2)],
    );
    expect(clip(ok(nudgeWithTool(s, 'slip', 'y', 0.5)), 'y').trimStart).toBeCloseTo(1.5);
    expect(clip(ok(nudgeWithTool(s, 'roll', 'x', 0.5)), 'x').trimEnd).toBeCloseTo(3.5);
    expect(lane(ok(nudgeWithTool(s, 'ripple', 'x', 0.5)), OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['y', 3.5]]);
    expect(lane(ok(nudgeWithTool(s, 'slide', 'y', 0.5)), OVERLAY_VIDEO_TRACK_ID)).toEqual([['x', 0], ['y', 3.5]]);
    expect(nudgeWithTool(s, 'select', 'y', 0.5).ok).toBe(false);
  });
});

describe('remapBaseTransitions', () => {
  it('follows a split tail through its alias', () => {
    const next = remapBaseTransitions(
      ['a', 'b'],
      ['a', 'n', 'a2', 'b'],
      [dissolve(1)],
      new Map([['a2', 'a']]),
    );
    expect(next).toEqual([dissolve(3)]);
  });

  it('drops a transition whose clips are no longer adjacent', () => {
    expect(remapBaseTransitions(['a', 'b'], ['a', 'n', 'b'], [dissolve(1)])).toEqual([]);
  });
});
