import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorActions, editorStore, __resetEditorStoreForTests } from './editorStore';
import { selectTimelineClips } from './selectors';
import { selectProjectSnapshotEditorFields } from '../project/snapshot';
import { isSequenceClip, nestedInstanceId } from '../timeline/sequenceResolve';
import { baseLaneOrder } from '../timeline/editModeCore';
import { seqTestClip, seqTestOverlay, seqTestState } from '../timeline/sequences.test.helpers';

function seed(): void {
  const { tracks, clips, textOverlays } = seqTestState(
    [seqTestClip('a', 5), seqTestClip('b', 3), seqTestClip('c', 4)],
    [],
    [seqTestOverlay('title')],
  );
  editorStore.setState({ tracks, clips, textOverlays, transitions: [], clipGroups: [] });
}

const state = () => editorStore.getState();

describe('editorStore — nested sequences', () => {
  beforeEach(() => {
    __resetEditorStoreForTests();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    seed();
  });
  afterEach(() => vi.restoreAllMocks());

  it('nests in one undo step and selects the new sequence clip', () => {
    expect(editorActions.nestClips({ clipIds: ['b', 'c'], textOverlayIds: ['title'], sequenceClipId: 'S' })).toBeNull();
    expect(baseLaneOrder(state().tracks)).toEqual(['a', 'S']);
    expect(state().selectedClipId).toBe('S');
    expect(state().sequences.map((seq) => seq.name)).toEqual(['Sequence 1']);

    editorActions.undo();
    expect(baseLaneOrder(state().tracks)).toEqual(['a', 'b', 'c']);
    expect(state().sequences).toEqual([]);
    expect(state().textOverlays.map((overlay) => overlay.id)).toEqual(['title']);

    editorActions.redo();
    expect(baseLaneOrder(state().tracks)).toEqual(['a', 'S']);
    expect(state().sequences).toHaveLength(1);
  });

  it('enters and exits without undo steps, and edits inside reach the parent', () => {
    editorActions.nestClips({ clipIds: ['b', 'c'], sequenceClipId: 'S' });
    const seqId = state().sequences[0]!.id;
    expect(editorActions.enterSequence(seqId)).toBeNull();
    expect(state().sequencePath).toEqual([seqId]);
    expect(state().clips.map((clip) => clip.id)).toEqual(['b', 'c']);

    // An ordinary undoable edit inside the sequence.
    editorActions.pushHistory();
    editorActions.setClips((clips) => clips.map((clip) => (clip.id === 'c' ? { ...clip, trimEnd: 1 } : clip)));

    // A save from inside is the whole project, with the edit.
    const saved = selectProjectSnapshotEditorFields(state());
    expect(saved.clips.map((clip) => clip.id)).toEqual(['a', 'S']);
    expect(saved.sequences[0]!.clips.find((clip) => clip.id === 'c')!.trimEnd).toBe(1);

    expect(editorActions.exitSequence()).toBeNull();
    expect(state().sequencePath).toEqual([]);
    const seqClip = state().clips.find((clip) => clip.id === 'S')!;
    expect(seqClip.duration).toBeCloseTo(4);
    const timeline = selectTimelineClips(state());
    expect(timeline.find((clip) => clip.id === 'S')!.nested!.clips.map((clip) => clip.id)).toEqual(['b', 'c']);
  });

  it('undo inside a sequence restores that sequence', () => {
    editorActions.nestClips({ clipIds: ['b', 'c'], sequenceClipId: 'S' });
    const seqId = state().sequences[0]!.id;
    editorActions.enterSequence(seqId);
    editorActions.pushHistory();
    editorActions.setClips((clips) => clips.filter((clip) => clip.id !== 'c'));
    editorActions.undo();
    expect(state().sequencePath).toEqual([seqId]);
    expect(state().clips.map((clip) => clip.id)).toEqual(['b', 'c']);
    // Undoing past the nest restores the flat root, wherever the editor is.
    editorActions.undo();
    expect(state().sequencePath).toEqual([]);
    expect(baseLaneOrder(state().tracks)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a cycle and reports why', () => {
    editorActions.nestClips({ clipIds: ['b', 'c'], sequenceClipId: 'S' });
    const outer = state().sequences[0]!.id;
    editorActions.enterSequence(outer);
    editorActions.nestClips({ clipIds: ['c'], sequenceClipId: 'T' });
    const inner = state().sequences.find((seq) => seq.id !== outer)!.id;
    editorActions.exitSequence();
    editorActions.enterSequence(inner);
    expect(editorActions.placeSequence(outer)).toMatch(/inside itself/);
    expect(state().clips.some(isSequenceClip)).toBe(false);
  });

  it('keeps the timeline-clip selector stable between edits (no React update loop)', () => {
    editorActions.nestClips({ clipIds: ['b', 'c'], sequenceClipId: 'S' });
    const first = selectTimelineClips(state());
    expect(selectTimelineClips(state())).toBe(first);
    const instance = first.find((clip) => clip.id === 'S')!.nested!.clips[0]!;
    expect(instance.id).toBe('b');
    expect(nestedInstanceId('S', instance.id)).toBe('S>b');
  });

  it('creates an empty sequence and opens it; reset clears every sequence', () => {
    const id = editorActions.createSequence('Blank');
    expect(state().sequencePath).toEqual([id]);
    expect(state().clips).toEqual([]);
    editorActions.exitToRootSequence();
    expect(state().sequencePath).toEqual([]);
    expect(baseLaneOrder(state().tracks)).toEqual(['a', 'b', 'c']);
    editorActions.resetHistory({ ...state(), selectedClipId: null, masterAudio: null });
    // resetHistory without sequences = a project that has none.
    editorActions.resetHistory({
      clips: [],
      tracks: [],
      clipGroups: [],
      transitions: [],
      textOverlays: [],
      captions: [],
      captionStyle: {},
      masterAudioMarkers: [],
      selectedClipId: null,
      masterAudio: null,
    });
    expect(state().sequences).toEqual([]);
  });
});
