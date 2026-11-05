import { describe, expect, it } from 'vitest';
import { selectTimelineClips } from './selectors';
import { getEffectiveTimelineClips } from '../timeline/trackModel';
import { editorStore } from './editorStore';
import { createTestClip } from '../project/project.test.helpers';

describe('selectTimelineClips', () => {
  it('matches getEffectiveTimelineClips and returns one array per input identity', () => {
    editorStore.getState().setClips([createTestClip('a', 2), createTestClip('b', 3)]);
    const state = editorStore.getState();
    const first = selectTimelineClips(state);
    expect(first).toEqual(getEffectiveTimelineClips(state.tracks, state.clips, state.clipGroups));
    expect(selectTimelineClips({ tracks: state.tracks, clips: state.clips, clipGroups: state.clipGroups })).toBe(first);
    editorStore.getState().setClips([createTestClip('c', 1)]);
    const next = selectTimelineClips(editorStore.getState());
    expect(next).not.toBe(first);
    expect(next).toEqual(
      getEffectiveTimelineClips(editorStore.getState().tracks, editorStore.getState().clips, editorStore.getState().clipGroups),
    );
  });
});
