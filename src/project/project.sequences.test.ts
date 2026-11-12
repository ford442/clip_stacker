import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { PROJECT_SCHEMA_VERSION } from '../types';
import { applyProjectData, createProjectSnapshot, serializeProject } from './index';
import { projectSnapshotClips, selectProjectSnapshotEditorFields } from './snapshot';
import { enterSequence, nestClips, type SequenceEditorState } from '../timeline/sequenceModel';
import { isSequenceClip, sequenceIdOf } from '../timeline/sequenceResolve';
import { baseLaneOrder } from '../timeline/editModeCore';
import { expectOk, seqTestClip, seqTestOverlay, seqTestState } from '../timeline/sequences.test.helpers';

/** The snapshot a save from this editor state writes. */
function snapshotOf(state: SequenceEditorState) {
  return createProjectSnapshot(
    selectProjectSnapshotEditorFields({
      ...state,
      captions: [],
      captionStyle: {},
      masterAudio: null,
      masterAudioMarkers: [],
      masterBus: undefined,
    }),
  );
}

function nestedProject() {
  const live = [seqTestClip('a', 5), seqTestClip('b', 3), seqTestClip('c', 4)];
  const state = expectOk(
    nestClips(seqTestState(live, [], [seqTestOverlay('title')]), {
      clipIds: ['b', 'c'],
      textOverlayIds: ['title'],
      sequenceId: 'seq-1',
      name: 'Intro',
      sequenceClipId: 'S',
    }),
  );
  return { live, state };
}

describe('project — nested sequences', () => {
  it('serializes sequences into the shared clip pool and claims them by id', () => {
    const { state } = nestedProject();
    const project = serializeProject(snapshotOf(state));
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(project.clips.map((clip) => clip.id).sort()).toEqual(['S', 'a', 'b', 'c']);
    expect(project.clips.find((clip) => clip.id === 'S')?.source).toEqual({ type: 'sequence', sequenceId: 'seq-1' });
    expect(project.sequences).toHaveLength(1);
    expect(project.sequences![0]).toMatchObject({ id: 'seq-1', name: 'Intro', clipIds: ['b', 'c'] });
    expect(project.sequences![0]!.textOverlays?.map((overlay) => overlay.id)).toEqual(['title']);
    expect(project.textOverlays ?? []).toEqual([]);
  });

  it('round-trips through JSON', async () => {
    const { live, state } = nestedProject();
    const json = JSON.stringify(serializeProject(snapshotOf(state)));
    const loaded = await applyProjectData(JSON.parse(json) as Project, live);

    expect(loaded.clips.map((clip) => clip.id)).toEqual(['a', 'S']);
    expect(baseLaneOrder(loaded.tracks)).toEqual(['a', 'S']);
    const seqClip = loaded.clips.find((clip) => clip.id === 'S')!;
    expect(isSequenceClip(seqClip)).toBe(true);
    expect(seqClip.duration).toBeCloseTo(7);
    expect(seqClip.title).toBe('Intro');

    expect(loaded.sequences).toHaveLength(1);
    const seq = loaded.sequences[0]!;
    expect(seq).toMatchObject({ id: 'seq-1', name: 'Intro' });
    expect(seq.clips.map((clip) => clip.id)).toEqual(['b', 'c']);
    expect(baseLaneOrder(seq.tracks)).toEqual(['b', 'c']);
    expect(seq.textOverlays.map((overlay) => overlay.id)).toEqual(['title']);
    expect(loaded.textOverlays).toEqual([]);
    expect(loaded.skippedClipCount).toBe(0);

    // Saving again writes the same project.
    const again = serializeProject(
      createProjectSnapshot({
        clips: loaded.clips,
        tracks: loaded.tracks,
        clipGroups: loaded.clipGroups,
        sequences: loaded.sequences,
        transitions: loaded.transitions,
        textOverlays: loaded.textOverlays,
      }),
    );
    expect(again.sequences).toEqual(JSON.parse(json).sequences);
  });

  it('saves the whole project while a sequence is open', () => {
    const { state } = nestedProject();
    const inside = expectOk(enterSequence(state, 'seq-1'));
    const edited = { ...inside, clips: inside.clips.map((clip) => (clip.id === 'b' ? { ...clip, title: 'B!' } : clip)) };
    const snapshot = snapshotOf(edited);
    expect(snapshot.clips.map((clip) => clip.id)).toEqual(['a', 'S']);
    expect(projectSnapshotClips(snapshot).map((clip) => clip.id).sort()).toEqual(['S', 'a', 'b', 'c']);
    const project = serializeProject(snapshot);
    expect(project.clips.find((clip) => clip.id === 'b')?.title).toBe('B!');
  });

  it('loads a project saved before sequences as the implicit root sequence', async () => {
    const live = [seqTestClip('a', 5)];
    const project: Project = {
      schemaVersion: 2,
      clips: [
        {
          id: 'a',
          title: 'a',
          kind: 'video',
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: 'a.mp4',
        },
      ],
    };
    const loaded = await applyProjectData(project, live);
    expect(loaded.sequences).toEqual([]);
    expect(loaded.clips.map((clip) => clip.id)).toEqual(['a']);
  });

  it('drops a sequence clip whose sequence is missing, and malformed sequences', async () => {
    const { live, state } = nestedProject();
    const project = serializeProject(snapshotOf(state));
    const broken: Project = {
      ...project,
      sequences: [
        null as never,
        { id: '', name: 'x', clipIds: [] },
        ...(project.sequences ?? []).map((seq) => ({ ...seq, id: 'other' })),
      ],
    };
    const loaded = await applyProjectData(broken, live);
    expect(loaded.clips.some((clip) => sequenceIdOf(clip) === 'seq-1')).toBe(false);
    expect(loaded.skippedClipCount).toBe(1);
    expect(loaded.sequences.map((seq) => seq.id)).toEqual(['other']);
  });
});
