import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip, Track } from '../types';
import { editorActions, editorStore, __resetEditorStoreForTests } from './editorStore';
import {
  overwriteEdit,
  rollEdit,
  slideClip,
  slipClip,
  type EditResult,
  type EditState,
} from '../utils/editModes';
import { createDefaultTracks, OVERLAY_VIDEO_TRACK_ID } from '../utils/trackModel';

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
