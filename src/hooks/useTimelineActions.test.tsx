/**
 * Lane-lock guards live in the action hooks, not the components, so the
 * block holds for keyboard shortcuts and programmatic callers too
 * (AGENTS.md, Timeline tracks). These tests drive the hook the way the
 * shortcuts do: straight calls, no UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { renderJobStore } from '../store/renderJobStore';
import { uiStore } from '../store/uiStore';
import { MAIN_VIDEO_TRACK_ID, migrateLegacyClipsToTracks } from '../timeline/trackModel';
import { useEditHistory } from './useEditHistory';
import { useTimelineActions } from './useTimelineActions';
import { renderHook, type RenderedHook } from './renderHook.test.helpers';

function makeClip(id: string, duration = 4): Clip {
  return {
    id,
    file: new File([new Uint8Array(16)], `${id}.mp4`, { type: 'video/mp4' }),
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
  };
}

type Actions = ReturnType<typeof useTimelineActions>;

function useProbe(): Actions {
  return useTimelineActions(useEditHistory());
}

const state = () => editorStore.getState();
const status = () => renderJobStore.getState().status;
const baseIds = () => state().tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!.items.map((i) => i.clipId);

describe('useTimelineActions lane-lock guards', () => {
  let hook: RenderedHook<Actions>;

  beforeEach(() => {
    __resetEditorStoreForTests();
    renderJobStore.getState().setStatus('');
    for (const id of ['a', 'b', 'c']) state().addClip(makeClip(id));
    hook = renderHook(useProbe);
  });

  afterEach(() => {
    hook.unmount();
    vi.unstubAllGlobals();
  });

  /** happy-dom has no window.confirm. */
  function stubConfirm(answer: boolean) {
    const confirm = vi.fn(() => answer);
    vi.stubGlobal('confirm', confirm);
    return confirm;
  }

  function lockMain(): void {
    state().toggleTrackLocked(MAIN_VIDEO_TRACK_ID);
    hook.rerender();
  }

  it('ripple delete closes the gap on an unlocked lane, as one undo step', () => {
    hook.current.handleRippleDelete('b');
    expect(baseIds()).toEqual(['a', 'c']);
    expect(status()).toMatch(/Ripple-deleted "b"/);
    state().undo();
    expect(baseIds()).toEqual(['a', 'b', 'c']);
  });

  it('refuses ripple delete, delete, nudge and drag on a locked lane', () => {
    lockMain();
    const before = state().tracks;
    const confirm = stubConfirm(true);

    hook.current.handleRippleDelete('b');
    expect(status()).toMatch(/Track is locked/);

    hook.current.handleDeleteClip('b');
    expect(confirm).not.toHaveBeenCalled();

    state().setSelectedClipId('b');
    hook.rerender();
    hook.current.handleEditNudge(1 / 30);

    hook.current.handleMoveToTrack('b', MAIN_VIDEO_TRACK_ID, 0);

    expect(state().tracks).toBe(before);
    expect(state().clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('refuses reorder (drag, move up / down) while the main lane is locked', () => {
    lockMain();
    hook.current.handleReorder(0, 3);
    expect(status()).toMatch(/unlock the lane to reorder/);
    hook.current.handleMoveUp(1);
    hook.current.handleMoveDown(0);
    expect(baseIds()).toEqual(['a', 'b', 'c']);
    expect(state().clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('reorders by main-lane index even when overlay clips sit in the pool, as one undo step', () => {
    __resetEditorStoreForTests();
    // Pool order: overlay, a, b, c — a lane index of 0 is `a`, not the overlay.
    const pool = [{ ...makeClip('o'), layerIndex: 1 }, makeClip('a'), makeClip('b'), makeClip('c')];
    state().setClips(pool);
    state().setTracks(migrateLegacyClipsToTracks(pool, []));
    hook.rerender();
    const poolBefore = state().clips.map((c) => c.id);

    hook.current.handleReorder(0, 3);
    expect(baseIds()).toEqual(['b', 'c', 'a']);
    expect(state().clips.map((c) => c.id).filter((id) => id !== 'o')).toEqual(['b', 'c', 'a']);

    state().undo();
    expect(baseIds()).toEqual(['a', 'b', 'c']);
    expect(state().clips.map((c) => c.id)).toEqual(poolBefore);
  });

  it('refuses a drop onto a locked target lane', () => {
    state().addTrack('video');
    const overlay = state().tracks.find((t) => t.kind === 'video' && t.id !== MAIN_VIDEO_TRACK_ID)!;
    state().toggleTrackLocked(overlay.id);
    hook.rerender();
    uiStore.setState({ snapEnabled: false });
    hook.current.handleMoveToTrack('b', overlay.id, 1);
    expect(status()).toBe('Target track is locked.');
    expect(baseIds()).toEqual(['a', 'b', 'c']);
  });

  it('delete asks first and keeps the clip when the user cancels', () => {
    const confirm = stubConfirm(false);
    hook.current.handleDeleteClip('b');
    expect(confirm).toHaveBeenCalledOnce();
    expect(state().clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});
