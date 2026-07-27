import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import {
  editorStore,
  editorActions,
  __resetEditorStoreForTests,
  DEFAULT_DEBOUNCE_MS,
} from './editorStore';

function makeClip(id: string, objectUrl = `blob:${id}`): Clip {
  const file = new File(['x'], `${id}.mp4`, { type: 'video/mp4' });
  return {
    id,
    file,
    objectUrl,
    title: id,
    kind: 'video',
    duration: 1,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('editorStore', () => {
  beforeEach(() => {
    __resetEditorStoreForTests();
    // Keep object-URL side effects inert so undo/redo can be tested in isolation.
    vi.spyOn(URL, 'createObjectURL').mockImplementation((): string => 'blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setClips accepts a direct value and a functional updater', () => {
    const { setClips } = editorStore.getState();
    setClips([makeClip('a')]);
    expect(editorStore.getState().clips.map((c) => c.id)).toEqual(['a']);

    setClips((prev) => [...prev, makeClip('b')]);
    expect(editorStore.getState().clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('pushHistory then undo/redo restores prior clip state', () => {
    const { setClips, pushHistory, undo, redo } = editorStore.getState();
    setClips([makeClip('a')]);

    pushHistory();
    setClips((prev) => [...prev, makeClip('b')]);
    expect(editorStore.getState().clips).toHaveLength(2);
    expect(editorStore.getState().undoDepth).toBe(1);

    undo();
    expect(editorStore.getState().clips.map((c) => c.id)).toEqual(['a']);
    expect(editorStore.getState().redoDepth).toBe(1);

    redo();
    expect(editorStore.getState().clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('pushHistory clears the redo stack', () => {
    const { setClips, pushHistory, undo } = editorStore.getState();
    setClips([makeClip('a')]);
    pushHistory();
    setClips((prev) => [...prev, makeClip('b')]);
    undo();
    expect(editorStore.getState().redoDepth).toBe(1);

    pushHistory();
    expect(editorStore.getState().redoDepth).toBe(0);
  });

  it('undo/redo are no-ops on empty stacks', () => {
    const { undo, redo } = editorStore.getState();
    expect(() => {
      undo();
      redo();
    }).not.toThrow();
    expect(editorStore.getState().undoDepth).toBe(0);
    expect(editorStore.getState().redoDepth).toBe(0);
  });

  it('does not record history while restoring a snapshot', () => {
    const { setClips, pushHistory, undo } = editorStore.getState();
    setClips([makeClip('a')]);
    pushHistory();
    setClips((prev) => [...prev, makeClip('b')]);
    // Undo restores; applying the snapshot must not itself push a new entry
    // beyond the single redo record.
    undo();
    expect(editorStore.getState().undoDepth).toBe(0);
    expect(editorStore.getState().redoDepth).toBe(1);
  });

  it('pushHistoryDebounced coalesces rapid edits into a single undo step', () => {
    vi.useFakeTimers();
    try {
      const { setClips, pushHistoryDebounced } = editorStore.getState();
      setClips([makeClip('a')]);

      pushHistoryDebounced('inspector:a');
      setClips([makeClip('a1')]);
      pushHistoryDebounced('inspector:a');
      setClips([makeClip('a2')]);

      // Only one undo entry captured for the whole burst.
      expect(editorStore.getState().undoDepth).toBe(1);

      // A later burst after the window closes starts a fresh entry.
      vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS + 1);
      pushHistoryDebounced('inspector:a');
      expect(editorStore.getState().undoDepth).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetHistory replaces state and clears the undo/redo stacks', () => {
    const { setClips, pushHistory, resetHistory } = editorStore.getState();
    setClips([makeClip('a')]);
    pushHistory();
    setClips((prev) => [...prev, makeClip('b')]);
    expect(editorStore.getState().undoDepth).toBe(1);

    resetHistory({
      clips: [makeClip('z')],
      clipGroups: [],
      transitions: [],
      textOverlays: [],
      selectedClipId: 'z',
    });

    expect(editorStore.getState().clips.map((c) => c.id)).toEqual(['z']);
    expect(editorStore.getState().selectedClipId).toBe('z');
    expect(editorStore.getState().undoDepth).toBe(0);
    expect(editorStore.getState().redoDepth).toBe(0);
  });

  describe('single-clip lookup equality stability', () => {
    it('preserves the untouched clip reference when another clip is edited', () => {
      const { setClips } = editorStore.getState();
      const a = makeClip('a');
      const b = makeClip('b');
      setClips([a, b]);

      const lookupA = () => editorStore.getState().clips.find((c) => c.id === 'a');
      const before = lookupA();

      // Editing clip 'b' via the codebase's standard immutable `.map` pattern
      // must not replace clip 'a's object reference.
      setClips((prev) =>
        prev.map((clip) => (clip.id === 'b' ? { ...clip, title: 'renamed' } : clip)),
      );

      expect(lookupA()).toBe(before);
    });

    it('returns a new reference only for the edited clip', () => {
      const { setClips } = editorStore.getState();
      setClips([makeClip('a')]);
      const before = editorStore.getState().clips.find((c) => c.id === 'a');

      setClips((prev) =>
        prev.map((clip) => (clip.id === 'a' ? { ...clip, title: 'renamed' } : clip)),
      );

      const after = editorStore.getState().clips.find((c) => c.id === 'a');
      expect(after).not.toBe(before);
      expect(after?.title).toBe('renamed');
    });

    it('returns null/undefined for a missing id without throwing', () => {
      editorStore.getState().setClips([makeClip('a')]);
      expect(editorStore.getState().clips.find((c) => c.id === 'missing')).toBeUndefined();
    });
  });

  describe('editorActions', () => {
    it('exposes the same stable action references as getState()', () => {
      expect(editorActions.setClips).toBe(editorStore.getState().setClips);
      expect(editorActions.pushHistory).toBe(editorStore.getState().pushHistory);
      expect(editorActions.undo).toBe(editorStore.getState().undo);
    });

    it('action references stay identical across state updates', () => {
      const before = editorActions.setClips;
      editorActions.setClips([makeClip('a')]);
      expect(editorStore.getState().setClips).toBe(before);
    });

    it('mutates the store like the getState()-destructured actions do', () => {
      editorActions.setClips([makeClip('a')]);
      expect(editorStore.getState().clips.map((c) => c.id)).toEqual(['a']);
    });
  });
});
