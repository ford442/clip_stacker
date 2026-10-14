import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, Track } from '../types';
import { editorActions, editorStore, __resetEditorStoreForTests } from './editorStore';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createElement } from 'react';
import {
  duplicateItem,
  overwriteEdit,
  rollEdit,
  slideClip,
  slipClip,
  type EditResult,
  type EditState,
} from '../utils/editModes';
import {
  createDefaultTracks,
  MAIN_VIDEO_TRACK_ID,
  OVERLAY_VIDEO_TRACK_ID,
} from '../utils/trackModel';
import { duplicateClip } from '../utils/clipOperations';
import { uiStore } from './uiStore';
import { settingsStore } from './settingsStore';
import { useClipActions } from '../hooks/useClipActions';

function trimmed(id: string, trimStart: number, len: number): Clip {
  return {
    id,
    file: new File(['x'], `${id}.mp4`, { type: 'video/mp4' }),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 10,
    trimStart,
    trimEnd: trimStart + len,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

function seed(): void {
  const clips = [trimmed('x', 0, 3), trimmed('y', 2, 2), trimmed('z', 2, 3)];
  const tracks: Track[] = createDefaultTracks();
  tracks[1] = {
    ...tracks[1],
    items: [
      { clipId: 'x', startTime: 0 },
      { clipId: 'y', startTime: 3 },
      { clipId: 'z', startTime: 5 },
    ],
  };
  editorStore.setState({ clips, tracks, transitions: [] });
}

function current(): EditState {
  const { tracks, clips, transitions } = editorStore.getState();
  return { tracks, clips, transitions };
}

function commit(result: EditResult): void {
  if (!result.ok) throw new Error(result.reason);
  editorActions.commitEdit(result.state);
}

/** Tracks + trims, comparable across snapshots. */
function fingerprint() {
  const { tracks, clips } = editorStore.getState();
  return {
    lane: tracks.find((t) => t.id === OVERLAY_VIDEO_TRACK_ID)!.items.map((i) => ({ ...i })),
    trims: clips.map((c) => [c.id, c.trimStart, c.trimEnd]),
  };
}

describe('editorStore.commitEdit', () => {
  beforeEach(() => {
    __resetEditorStoreForTests();
    vi.spyOn(URL, 'createObjectURL').mockImplementation((): string => 'blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['roll', () => rollEdit(current(), 'x', 0.5)],
    ['slip', () => slipClip(current(), 'y', 0.5)],
    ['slide', () => slideClip(current(), 'y', 0.5)],
  ])('one undo restores tracks and clip trims after a %s', (_name, edit) => {
    const before = fingerprint();
    commit(edit());
    expect(fingerprint()).not.toEqual(before);
    expect(editorStore.getState().undoDepth).toBe(1);

    editorActions.undo();
    expect(fingerprint()).toEqual(before);

    editorActions.redo();
    expect(fingerprint()).not.toEqual(before);
  });

  it('drops the selection when the edit removed the selected clip', () => {
    editorStore.setState({
      clips: [...editorStore.getState().clips, trimmed('n', 0, 8)],
      selectedClipId: 'y',
    });
    commit(overwriteEdit(current(), 'n', OVERLAY_VIDEO_TRACK_ID, 0));
    expect(editorStore.getState().selectedClipId).toBeNull();
  });

  it('undoing a split overwrite keeps the media URL the head still uses', () => {
    editorStore.setState({ clips: [...editorStore.getState().clips, trimmed('n', 0, 1)] });
    commit(overwriteEdit(current(), 'n', OVERLAY_VIDEO_TRACK_ID, 1));
    // x was split around n; the tail shares x's object URL.
    expect(editorStore.getState().clips.filter((c) => c.objectUrl === 'blob:x')).toHaveLength(2);
    editorActions.undo();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:x');
  });
});

function lane(trackId: string) {
  return editorStore.getState().tracks.find((t) => t.id === trackId)!.items
    .slice()
    .sort((a, b) => a.startTime - b.startTime);
}

/** Base lane a(3s) b(2s) c(3s) with a 1s crossfade from b into c. */
function seedBase(): void {
  const clips = [trimmed('a', 0, 3), trimmed('b', 2, 2), trimmed('c', 2, 3)];
  const tracks: Track[] = createDefaultTracks();
  tracks[0] = {
    ...tracks[0],
    items: [
      { clipId: 'a', startTime: 0 },
      { clipId: 'b', startTime: 3 },
      { clipId: 'c', startTime: 4 },
    ],
  };
  editorStore.setState({
    clips,
    tracks,
    transitions: [{ afterClipIndex: 2, type: 'fade', duration: 1 }],
  });
}

describe('duplicateItem', () => {
  beforeEach(() => {
    __resetEditorStoreForTests();
    vi.spyOn(URL, 'createObjectURL').mockImplementation((): string => 'blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts the copy after the source on an overlay lane and ripples later items', () => {
    seed();
    const copy = duplicateClip(editorStore.getState().clips[1]);
    commit(duplicateItem(current(), 'y', copy, 'insert'));
    expect(lane(OVERLAY_VIDEO_TRACK_ID)).toEqual([
      { clipId: 'x', startTime: 0 },
      { clipId: 'y', startTime: 3 },
      { clipId: copy.id, startTime: 5 },
      { clipId: 'z', startTime: 7 },
    ]);
    // Pool order keeps the copy next to its source.
    expect(editorStore.getState().clips.map((c) => c.id)).toEqual(['x', 'y', copy.id, 'z']);
  });

  it('overwrites what follows on an overlay lane in overwrite mode', () => {
    seed();
    const copy = duplicateClip(editorStore.getState().clips[1]);
    commit(duplicateItem(current(), 'y', copy, 'overwrite'));
    const items = lane(OVERLAY_VIDEO_TRACK_ID);
    expect(items.map((i) => [i.clipId, i.startTime])).toEqual([
      ['x', 0],
      ['y', 3],
      [copy.id, 5],
      ['z', 7],
    ]);
    // z (5–8s) lost its first 2s under the copy.
    const z = editorStore.getState().clips.find((c) => c.id === 'z')!;
    expect(z.trimStart).toBeCloseTo(4);
  });

  it('always inserts on the base lane and keeps the xfade on the pair it joined', () => {
    seedBase();
    const copy = duplicateClip(editorStore.getState().clips[1]);
    // Overwrite mode still inserts on the gapless base lane.
    commit(duplicateItem(current(), 'b', copy, 'overwrite'));
    expect(lane(MAIN_VIDEO_TRACK_ID).map((i) => [i.clipId, i.startTime])).toEqual([
      ['a', 0],
      ['b', 3],
      [copy.id, 5],
      ['c', 6],
    ]);
    // The b→c crossfade now leaves the copy: slot 3 is copy→c.
    expect(editorStore.getState().transitions).toEqual([
      { afterClipIndex: 3, type: 'fade', duration: 1 },
    ]);
  });

  it('is one undo step', () => {
    seedBase();
    const before = {
      tracks: editorStore.getState().tracks,
      clips: editorStore.getState().clips.map((c) => c.id),
      transitions: editorStore.getState().transitions,
    };
    const copy = duplicateClip(editorStore.getState().clips[1]);
    commit(duplicateItem(current(), 'b', copy, 'insert'));
    expect(editorStore.getState().undoDepth).toBe(1);
    editorActions.undo();
    expect(editorStore.getState().tracks).toEqual(before.tracks);
    expect(editorStore.getState().clips.map((c) => c.id)).toEqual(before.clips);
    expect(editorStore.getState().transitions).toEqual(before.transitions);
  });

  it('refuses a locked lane', () => {
    seed();
    editorStore.setState({
      tracks: editorStore.getState().tracks.map((t) =>
        t.id === OVERLAY_VIDEO_TRACK_ID ? { ...t, locked: true } : t,
      ),
    });
    const copy = duplicateClip(editorStore.getState().clips[1]);
    const result = duplicateItem(current(), 'y', copy, 'insert');
    expect(result.ok).toBe(false);
  });

  describe('handleDuplicateClip', () => {
    function mountActions(): ReturnType<typeof useClipActions> {
      let actions: ReturnType<typeof useClipActions> | null = null;
      function Probe() {
        const s = editorStore.getState();
        actions = useClipActions({
          clips: s.clips,
          selectedClipId: s.selectedClipId,
          setClips: s.setClips,
          setTracks: s.setTracks,
          setClipGroups: s.setClipGroups,
          setTransitions: s.setTransitions,
          setSelectedClipId: s.setSelectedClipId,
          pushHistory: s.pushHistory,
        });
        return null;
      }
      const root = createRoot(document.createElement('div'));
      act(() => {
        root.render(createElement(Probe));
      });
      return actions!;
    }

    it('places the copy on the source lane immediately and selects it', () => {
      seedBase();
      uiStore.getState().setDropEditMode('insert');
      editorStore.setState({ selectedClipId: 'b' });
      mountActions().handleDuplicateClip();
      const state = editorStore.getState();
      expect(state.clips).toHaveLength(4);
      const copyId = state.selectedClipId!;
      expect(copyId).not.toBe('b');
      expect(lane(MAIN_VIDEO_TRACK_ID).map((i) => i.clipId)).toEqual(['a', 'b', copyId, 'c']);
      expect(state.undoDepth).toBe(1);
    });

    it('reports a locked lane and changes nothing', () => {
      seedBase();
      editorStore.setState({
        selectedClipId: 'b',
        tracks: editorStore.getState().tracks.map((t) =>
          t.id === MAIN_VIDEO_TRACK_ID ? { ...t, locked: true } : t,
        ),
      });
      mountActions().handleDuplicateClip();
      expect(editorStore.getState().clips).toHaveLength(3);
      expect(editorStore.getState().undoDepth).toBe(0);
      expect(settingsStore.getState().status).toMatch(/locked/);
    });
  });
});
