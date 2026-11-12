import { describe, expect, it } from 'vitest';
import {
  committedSequences,
  createSequence,
  deleteSequence,
  enterSequence,
  exitSequence,
  exitToRoot,
  nestClips,
  placeSequence,
  renameSequence,
  sequenceBodyDuration,
  type SequenceEditorState,
} from './sequenceModel';
import { baseLaneOrder } from './editModeCore';
import { MAIN_VIDEO_TRACK_ID, OVERLAY_VIDEO_TRACK_ID } from './trackBasics';
import { isSequenceClip, sequenceIdOf } from './sequenceResolve';
import { expectOk, seqTestClip, seqTestOverlay, seqTestState } from './sequences.test.helpers';

function nest(state: SequenceEditorState, clipIds: string[], textOverlayIds: string[] = [], sequenceId = 'seq-1') {
  return nestClips(state, { clipIds, textOverlayIds, sequenceId, name: sequenceId, sequenceClipId: `clip-${sequenceId}` });
}

describe('nestClips', () => {
  it('moves two main-lane clips and a title into a sequence placed where they were', () => {
    const state = seqTestState(
      [seqTestClip('a', 5), seqTestClip('b', 3), seqTestClip('c', 4)],
      [],
      [seqTestOverlay('title')],
    );
    const next = expectOk(nest(state, ['b', 'c'], ['title']));

    expect(baseLaneOrder(next.tracks)).toEqual(['a', 'clip-seq-1']);
    const seqClip = next.clips.find((clip) => clip.id === 'clip-seq-1')!;
    expect(isSequenceClip(seqClip)).toBe(true);
    expect(seqClip.duration).toBeCloseTo(7);
    expect(next.tracks[0]!.items.find((item) => item.clipId === 'clip-seq-1')?.startTime).toBeCloseTo(5);
    expect(next.textOverlays).toEqual([]);

    expect(next.sequences).toHaveLength(1);
    const seq = next.sequences[0]!;
    expect(seq.clips.map((clip) => clip.id)).toEqual(['b', 'c']);
    expect(seq.textOverlays.map((overlay) => overlay.id)).toEqual(['title']);
    expect(baseLaneOrder(seq.tracks)).toEqual(['b', 'c']);
    expect(seq.tracks[0]!.items.map((item) => item.startTime)).toEqual([0, 3]);
    expect(sequenceBodyDuration(seq)).toBeCloseTo(7);
  });

  it('keeps an overlay on its lane, offset from the window start', () => {
    const state = seqTestState([seqTestClip('a', 5), seqTestClip('b', 5)], [[seqTestClip('pip', 2), 6]]);
    const next = expectOk(nest(state, ['b', 'pip']));
    const seq = next.sequences[0]!;
    const overlayLane = seq.tracks.find((track) => track.id === OVERLAY_VIDEO_TRACK_ID)!;
    expect(overlayLane.items).toEqual([{ clipId: 'pip', startTime: 1 }]);
    // The parent's overlay lane no longer holds it.
    expect(next.tracks.find((track) => track.id === OVERLAY_VIDEO_TRACK_ID)!.items).toEqual([]);
  });

  it('nests overlay-only selections onto the overlay lane', () => {
    const state = seqTestState([seqTestClip('a', 10)], [[seqTestClip('pip', 2), 4]]);
    const next = expectOk(nest(state, ['pip']));
    const lane = next.tracks.find((track) => track.id === OVERLAY_VIDEO_TRACK_ID)!;
    expect(lane.items).toEqual([{ clipId: 'clip-seq-1', startTime: 4 }]);
    expect(baseLaneOrder(next.tracks)).toEqual(['a']);
  });

  it('moves inner transitions into the sequence and re-keys the parent ones', () => {
    const state = {
      ...seqTestState([seqTestClip('a', 5), seqTestClip('b', 5), seqTestClip('c', 5), seqTestClip('d', 5)]),
      transitions: [
        { afterClipIndex: 1, type: 'dissolve' as const, duration: 1 },
        { afterClipIndex: 2, type: 'dissolve' as const, duration: 1 },
        { afterClipIndex: 3, type: 'dissolve' as const, duration: 1 },
      ],
    };
    const next = expectOk(nest(state, ['b', 'c']));
    expect(next.sequences[0]!.transitions.map((t) => t.afterClipIndex)).toEqual([1]);
    expect(next.transitions.map((t) => t.afterClipIndex)).toEqual([1, 2]);
  });

  it('refuses a broken run on the main lane, audio-only picks and locked lanes', () => {
    const state = seqTestState([seqTestClip('a', 2), seqTestClip('b', 2), seqTestClip('c', 2)]);
    expect(nest(state, ['a', 'c']).ok).toBe(false);
    expect(nest(state, []).ok).toBe(false);
    const locked = {
      ...state,
      tracks: state.tracks.map((track) => (track.id === MAIN_VIDEO_TRACK_ID ? { ...track, locked: true } : track)),
    };
    expect(nest(locked, ['a']).ok).toBe(false);
  });
});

describe('sequence navigation', () => {
  it('edits inside a sequence and updates the parent clip length on exit', () => {
    const root = expectOk(nest(seqTestState([seqTestClip('a', 5), seqTestClip('b', 3)]), ['a', 'b']));
    const inside = expectOk(enterSequence(root, 'seq-1'));
    expect(inside.sequencePath).toEqual(['seq-1']);
    expect(inside.clips.map((clip) => clip.id)).toEqual(['a', 'b']);
    expect(inside.rootStash?.clips.map((clip) => clip.id)).toEqual(['clip-seq-1']);

    // Trim `b` to 1 s inside the sequence.
    const edited = { ...inside, clips: inside.clips.map((clip) => (clip.id === 'b' ? { ...clip, trimEnd: 1 } : clip)) };
    const back = expectOk(exitSequence(edited));
    expect(back.sequencePath).toEqual([]);
    expect(back.clips.find((clip) => clip.id === 'clip-seq-1')!.duration).toBeCloseTo(6);
    expect(committedSequences(back)[0]!.clips.find((clip) => clip.id === 'b')!.trimEnd).toBe(1);
  });

  it('commits the open sequence for save without leaving it', () => {
    const root = expectOk(nest(seqTestState([seqTestClip('a', 5)]), ['a']));
    const inside = expectOk(enterSequence(root, 'seq-1'));
    const edited = { ...inside, clips: inside.clips.map((clip) => ({ ...clip, title: 'renamed' })) };
    expect(committedSequences(edited)[0]!.clips[0]!.title).toBe('renamed');
    expect(exitToRoot(edited).sequencePath).toEqual([]);
  });
});

describe('cycles', () => {
  it('rejects A contains B contains A', () => {
    // seq-1 in the root; seq-2 nested inside seq-1.
    let state = expectOk(nest(seqTestState([seqTestClip('a', 4), seqTestClip('b', 4)]), ['a', 'b'], [], 'seq-1'));
    state = expectOk(enterSequence(state, 'seq-1'));
    state = expectOk(nest(state, ['b'], [], 'seq-2'));
    state = expectOk(exitSequence(state));
    expect(committedSequences(state).find((seq) => seq.id === 'seq-1')!.clips.some((clip) => sequenceIdOf(clip) === 'seq-2')).toBe(true);

    // Inside seq-2, placing seq-1 would make seq-2 contain itself.
    const inner = expectOk(enterSequence(state, 'seq-2'));
    const refused = placeSequence(inner, 'seq-1');
    expect(refused.ok).toBe(false);
    // So does placing seq-2 inside itself.
    expect(placeSequence(inner, 'seq-2').ok).toBe(false);
    // The root can place either.
    expect(placeSequence(state, 'seq-2').ok).toBe(true);
  });
});

describe('sequence library edits', () => {
  it('creates, renames and deletes sequences, refusing deletes of placed ones', () => {
    let state = seqTestState([seqTestClip('a', 4)]);
    state = expectOk(createSequence(state, { id: 'empty', name: 'Empty' }));
    expect(placeSequence(state, 'empty').ok).toBe(false); // nothing in it
    state = expectOk(nest(state, ['a']));
    state = expectOk(renameSequence(state, 'seq-1', 'Intro'));
    expect(state.clips.find((clip) => clip.id === 'clip-seq-1')!.title).toBe('Intro');
    expect(deleteSequence(state, 'seq-1').ok).toBe(false);
    state = expectOk(deleteSequence(state, 'empty'));
    expect(state.sequences.map((seq) => seq.id)).toEqual(['seq-1']);
  });
});
