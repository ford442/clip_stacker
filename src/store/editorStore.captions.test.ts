import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptionEntry } from '../types';
import {
  editorStore,
  editorActions,
  __resetEditorStoreForTests,
} from './editorStore';
import { MIN_CAPTION_DURATION_SEC } from '../utils/subtitles';

const CUE_A: CaptionEntry = { id: 'a', startSec: 3, endSec: 4, text: 'Later' };
const CUE_B: CaptionEntry = { id: 'b', startSec: 1, endSec: 2, text: 'Earlier' };

describe('editorStore captions', () => {
  beforeEach(() => {
    __resetEditorStoreForTests();
  });

  it('starts with an empty caption track and no style overrides', () => {
    expect(editorStore.getState().captions).toEqual([]);
    expect(editorStore.getState().captionStyle).toEqual({});
  });

  it('keeps cues sorted by start time on every write', () => {
    editorActions.setCaptions([CUE_A, CUE_B]);
    expect(editorStore.getState().captions.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('enforces the minimum cue duration on write', () => {
    editorActions.setCaptions([{ id: 'z', startSec: 5, endSec: 5, text: 'Instant' }]);
    expect(editorStore.getState().captions[0].endSec).toBeCloseTo(
      5 + MIN_CAPTION_DURATION_SEC,
      6,
    );
  });

  it('accepts a functional updater like the other slices', () => {
    editorActions.setCaptions([CUE_B]);
    editorActions.setCaptions((prev) => [...prev, CUE_A]);
    expect(editorStore.getState().captions).toHaveLength(2);
  });

  it('captures captions in undo/redo snapshots', () => {
    editorActions.setCaptions([CUE_B]);
    editorActions.pushHistory();
    editorActions.setCaptions([CUE_B, CUE_A]);
    expect(editorStore.getState().captions).toHaveLength(2);

    editorActions.undo();
    expect(editorStore.getState().captions.map((c) => c.id)).toEqual(['b']);

    editorActions.redo();
    expect(editorStore.getState().captions.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('captures the caption style in undo/redo snapshots', () => {
    editorActions.setCaptionStyle({ fontsize: 40 });
    editorActions.pushHistory();
    editorActions.setCaptionStyle({ fontsize: 90 });

    editorActions.undo();
    expect(editorStore.getState().captionStyle).toEqual({ fontsize: 40 });
  });

  it('restores captions from a snapshot without sharing cue objects', () => {
    const cue = { ...CUE_B };
    editorActions.setCaptions([cue]);
    editorActions.pushHistory();
    editorActions.setCaptions([]);
    editorActions.undo();

    const restored = editorStore.getState().captions[0];
    expect(restored).toEqual(cue);
    expect(restored).not.toBe(cue);
  });

  it('resetHistory replaces the caption track and clears the stacks', () => {
    editorActions.setCaptions([CUE_B]);
    editorActions.pushHistory();
    editorActions.resetHistory({
      clips: [],
      tracks: editorStore.getState().tracks,
      clipGroups: [],
      transitions: [],
      textOverlays: [],
      captions: [CUE_A],
      captionStyle: { box: false },
      masterAudioMarkers: [],
      selectedClipId: null,
      masterAudio: null,
    });

    expect(editorStore.getState().captions.map((c) => c.id)).toEqual(['a']);
    expect(editorStore.getState().captionStyle).toEqual({ box: false });
    expect(editorStore.getState().undoDepth).toBe(0);
  });
});
