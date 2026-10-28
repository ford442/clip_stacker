import { describe, expect, it } from 'vitest';
import type { Clip, ClipTransition } from '../../types';
import { normalizeBaseLane, type EditState } from '../editModeCore';
import { getClipDuration } from '../clipTiming';
import { createDefaultTracks, setTrackLocked, MAIN_VIDEO_TRACK_ID } from '../trackModel';
import {
  planSegmentReplacement,
  SEGMENT_DURATION_TOLERANCE_SEC,
  type SegmentMedia,
  type SegmentReplaceOutcome,
} from './segmentReplace';

function makeClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

function baseState(clips: Clip[], transitions: ClipTransition[] = []): EditState {
  const tracks = createDefaultTracks();
  tracks[0] = { ...tracks[0], items: clips.map((c, i) => ({ clipId: c.id, startTime: i * 100 })) };
  return { tracks: normalizeBaseLane(tracks, clips, transitions), clips, transitions };
}

function media(durationSec: number, overrides: Partial<SegmentMedia> = {}): SegmentMedia {
  return {
    file: new File([], 'processed.mp4', { type: 'video/mp4' }),
    objectUrl: 'blob:processed',
    durationSec,
    videoWidth: 640,
    videoHeight: 360,
    ...overrides,
  };
}

function ok(outcome: SegmentReplaceOutcome) {
  if (!outcome.ok) throw new Error(`expected success: ${outcome.reason}`);
  return outcome;
}

function lane(state: EditState): [string, number][] {
  const track = state.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!;
  return [...track.items]
    .sort((a, b) => a.startTime - b.startTime)
    .map((i) => [i.clipId, Number(i.startTime.toFixed(4))]);
}

function laneEnd(state: EditState): number {
  const track = state.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!;
  return Math.max(
    ...track.items.map((i) => i.startTime + getClipDuration(state.clips.find((c) => c.id === i.clipId)!)),
  );
}

describe('planSegmentReplacement', () => {
  it('swaps the media of a clip when the segment is its whole trim range', () => {
    const state = baseState([makeClip('a', { trimStart: 2, trimEnd: 6 }), makeClip('b')]);
    const before = lane(state);
    const out = ok(planSegmentReplacement(state, { clipId: 'a', startSec: 2, endSec: 6, media: media(4.1) }));

    expect(lane(out.state)).toEqual(before);
    expect(out.replacedClipId).toBe('a');
    expect(out.splitSourceClip).toBeUndefined();
    const a = out.state.clips.find((c) => c.id === 'a')!;
    expect(a.objectUrl).toBe('blob:processed');
    expect(a.duration).toBe(4.1);
    // Pinned to exactly the segment length even though the media is slightly longer.
    expect([a.trimStart, a.trimEnd]).toEqual([0, 4]);
    expect(getClipDuration(a)).toBe(4);
  });

  it('cuts [before][replaced][after] at the same output times for a sub-range', () => {
    const state = baseState([makeClip('a'), makeClip('b')]);
    const [[, bStart]] = lane(state).filter(([id]) => id === 'b');
    const endBefore = laneEnd(state);
    const out = ok(planSegmentReplacement(state, { clipId: 'a', startSec: 3, endSec: 7, media: media(4) }));

    const ids = lane(out.state).map(([id]) => id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe('a');
    expect(ids[3]).toBe('b');
    const [left, mid, right] = ids.slice(0, 3).map((id) => out.state.clips.find((c) => c.id === id)!);
    expect([left.trimStart, left.trimEnd]).toEqual([0, 3]);
    expect([mid.trimStart, mid.trimEnd]).toEqual([0, 4]);
    expect([right.trimStart, right.trimEnd]).toEqual([7, NaN]);
    expect(mid.objectUrl).toBe('blob:processed');
    expect(out.replacedClipId).toBe(mid.id);
    expect(out.splitSourceClip?.id).toBe('a');
    expect(lane(out.state).map(([, t]) => t)).toEqual([0, 3, 7, bStart]);
    expect(laneEnd(out.state)).toBeCloseTo(endBefore, 6);
  });

  it('lets the replaced piece keep the source id when the segment starts the clip', () => {
    const state = baseState([makeClip('a')]);
    const out = ok(planSegmentReplacement(state, { clipId: 'a', startSec: 0, endSec: 4, media: media(4) }));
    expect(out.replacedClipId).toBe('a');
    expect(lane(out.state)).toHaveLength(2);
    const a = out.state.clips.find((c) => c.id === 'a')!;
    expect(a.objectUrl).toBe('blob:processed');
  });

  it('keeps base transitions attached to the clips they joined', () => {
    const clips = [makeClip('a', { trimEnd: 5 }), makeClip('b', { trimEnd: 5 }), makeClip('c', { trimEnd: 5 })];
    const transitions: ClipTransition[] = [
      { afterClipIndex: 1, type: 'dissolve', duration: 1 },
      { afterClipIndex: 2, type: 'dissolve', duration: 1 },
    ];
    const out = ok(
      planSegmentReplacement(baseState(clips, transitions), { clipId: 'b', startSec: 1, endSec: 3, media: media(2) }),
    );
    // a→[b-left] stays at slot 1; [b-right]→c moves from slot 2 to slot 4.
    expect(out.state.transitions.map((t) => t.afterClipIndex)).toEqual([1, 4]);
  });

  it('rejects a result whose length does not match the segment', () => {
    const state = baseState([makeClip('a')]);
    const bad = planSegmentReplacement(state, {
      clipId: 'a',
      startSec: 2,
      endSec: 6,
      media: media(4 + SEGMENT_DURATION_TOLERANCE_SEC + 0.05),
    });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.reason).toMatch(/has to match/);
    expect(
      planSegmentReplacement(state, { clipId: 'a', startSec: 2, endSec: 6, media: media(3.5) }).ok,
    ).toBe(false);
    expect(
      planSegmentReplacement(state, { clipId: 'a', startSec: 2, endSec: 6, media: media(4 + SEGMENT_DURATION_TOLERANCE_SEC) }).ok,
    ).toBe(true);
  });

  it('rejects windows outside the trim range, slivers, locked lanes and missing clips', () => {
    const state = baseState([makeClip('a', { trimStart: 2, trimEnd: 8 })]);
    const plan = (s: EditState, id: string, a: number, b: number) =>
      planSegmentReplacement(s, { clipId: id, startSec: a, endSec: b, media: media(b - a) });
    expect(plan(state, 'a', 1, 4)).toMatchObject({ ok: false });
    expect(plan(state, 'a', 6, 9)).toMatchObject({ ok: false });
    expect(plan(state, 'a', 2.05, 5)).toMatchObject({ ok: false }); // 0.05s sliver on the left
    expect(plan(state, 'a', 3, 7.95)).toMatchObject({ ok: false }); // 0.05s sliver on the right
    expect(plan(state, 'zzz', 2, 5)).toMatchObject({ ok: false });
    const locked = { ...state, tracks: setTrackLocked(state.tracks, MAIN_VIDEO_TRACK_ID, true) };
    expect(plan(locked, 'a', 2, 5)).toMatchObject({ ok: false });
  });

  it.each([
    ['sped up', { playbackRate: 2 }],
    ['looped', { loopCount: 2 }],
    ['reversed', { reversed: true }],
    ['speed-automated', { automation: { playbackRate: [{ time: 0, value: 1 }, { time: 1, value: 2 }] } }],
  ] as [string, Partial<Clip>][])('only swaps the whole range of a %s clip', (_name, overrides) => {
    const state = baseState([makeClip('a', overrides)]);
    expect(
      planSegmentReplacement(state, { clipId: 'a', startSec: 2, endSec: 5, media: media(3) }),
    ).toMatchObject({ ok: false });
    const whole = ok(planSegmentReplacement(state, { clipId: 'a', startSec: 0, endSec: 10, media: media(10) }));
    expect(whole.replacedClipId).toBe('a');
    // Speed, loops and direction still apply to the new media.
    expect(whole.state.clips[0]).toMatchObject(overrides);
  });

  it('drops data derived from the old pixels and re-bases markers into the new media', () => {
    const state = baseState([
      makeClip('a', {
        stabilize: true,
        beatTimestamps: [1, 2],
        bpmEstimate: 120,
        remoteAudioUrl: 'https://x/a.wav',
        remoteSourceUrl: 'https://x/a.mp4',
        syncMarkers: [
          { id: 'm1', time: 1, text: 'before' },
          { id: 'm2', time: 4, text: 'inside' },
        ],
      }),
    ]);
    const out = ok(
      planSegmentReplacement(state, {
        clipId: 'a', startSec: 3, endSec: 6, media: media(3, { remoteUrl: 'https://s/media/p.mp4' }),
      }),
    );
    const mid = out.state.clips.find((c) => c.id === out.replacedClipId)!;
    expect(mid.stabilize).toBe(true); // the user's toggle stays; the analysis is recomputed
    expect(mid.beatTimestamps).toBeUndefined();
    expect(mid.bpmEstimate).toBeUndefined();
    expect(mid.remoteAudioUrl).toBeUndefined();
    expect(mid.remoteSourceUrl).toBe('https://s/media/p.mp4');
    expect(mid.syncMarkers).toEqual([{ id: 'm2', time: 1, text: 'inside' }]);
    // The untouched pieces still describe the original media.
    expect(out.state.clips.find((c) => c.id === 'a')!.remoteSourceUrl).toBe('https://x/a.mp4');
  });

  it('does not mutate the input state', () => {
    const state = baseState([makeClip('a'), makeClip('b')]);
    const snapshot = JSON.stringify({ t: state.tracks, c: state.clips.map((c) => [c.id, c.trimStart, c.trimEnd, c.objectUrl]) });
    ok(planSegmentReplacement(state, { clipId: 'a', startSec: 3, endSec: 7, media: media(4) }));
    expect(JSON.stringify({ t: state.tracks, c: state.clips.map((c) => [c.id, c.trimStart, c.trimEnd, c.objectUrl]) })).toBe(snapshot);
  });
});
