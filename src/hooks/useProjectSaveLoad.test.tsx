/**
 * useProjectSaveLoad: the file save writes the one project snapshot
 * (`selectProjectSnapshot`) with media embedded, and loading it back restores
 * every field in one history reset. Remote storage is mocked at the client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptionEntry, Clip, Project } from '../types';
import { DEFAULT_FINISHING, DEFAULT_SHARPEN, type FinishingSettings } from '../finishing/finishing';
import { DEFAULT_COLOR_MANAGEMENT } from '../finishing/colorManagement';
import { EMPTY_PROJECT_SAVE_MESSAGE } from '../project/projectSave';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { renderJobStore } from '../store/renderJobStore';
import { useEditHistory } from './useEditHistory';
import { useProjectSaveLoad } from './useProjectSaveLoad';
import { act, renderHook, type RenderedHook } from './renderHook.test.helpers';

// happy-dom cannot decode media; loading only needs a duration back.
vi.mock('../media/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/media')>()),
  getMediaInfo: vi.fn(async (file: File) => ({ duration: 3, objectUrl: URL.createObjectURL(file) })),
}));

function makeClip(id: string): Clip {
  return {
    id,
    file: new File([new Uint8Array(64)], `${id}.mp4`, { type: 'video/mp4' }),
    objectUrl: `blob:${id}`,
    title: `${id}.mp4`,
    kind: 'video',
    duration: 3,
    trimStart: 0.5,
    trimEnd: 2.5,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

const CAPTIONS: CaptionEntry[] = [{ id: 'c1', startSec: 0.2, endSec: 1, text: 'Hello' }];
const FINISHING: FinishingSettings = {
  ...DEFAULT_FINISHING,
  sharpen: { ...DEFAULT_SHARPEN, enabled: true, amount: 0.6 },
};

type Actions = ReturnType<typeof useProjectSaveLoad>;

function useProbe(): Actions {
  return useProjectSaveLoad(useEditHistory());
}

const status = () => renderJobStore.getState().status;

/** Capture the JSON the save hands to the download anchor. */
function captureDownload(): () => Promise<Project> {
  let blob: Blob | null = null;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    if (value instanceof Blob && value.type === 'application/json') blob = value;
    return 'blob:download';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return async () => {
    expect(click).toHaveBeenCalledOnce();
    expect(blob).not.toBeNull();
    return JSON.parse(await blob!.text()) as Project;
  };
}

describe('useProjectSaveLoad', () => {
  let hook: RenderedHook<Actions>;

  beforeEach(() => {
    __resetEditorStoreForTests();
    settingsStore.getState().setFinishing(DEFAULT_FINISHING);
    settingsStore.getState().setColorManagement(DEFAULT_COLOR_MANAGEMENT);
    renderJobStore.getState().setStatus('');
    hook = renderHook(useProbe);
  });

  afterEach(() => {
    hook.unmount();
    vi.restoreAllMocks();
  });

  it('refuses to save an empty project (file and remote)', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    await act(() => hook.current.handleSaveProject());
    expect(status()).toBe(EMPTY_PROJECT_SAVE_MESSAGE);
    expect(click).not.toHaveBeenCalled();

    renderJobStore.getState().setStatus('');
    await act(() => hook.current.handleSaveRemote('https://storage.example/api', '', 'p'));
    expect(status()).toBe(EMPTY_PROJECT_SAVE_MESSAGE);
  });

  it('saves the project snapshot with the media embedded', async () => {
    act(() => {
      editorStore.getState().addClip(makeClip('a'));
      editorStore.getState().setCaptions(CAPTIONS);
      settingsStore.getState().setFinishing(FINISHING);
    });
    const download = captureDownload();
    await act(() => hook.current.handleSaveProject());
    const project = await download();

    expect(project.clips).toHaveLength(1);
    expect(project.clips[0]).toMatchObject({ id: 'a', trimStart: 0.5, trimEnd: 2.5 });
    expect(project.clips[0]!.sourceMediaDataUrl).toMatch(/^data:video\/mp4;base64,/);
    expect(project.captions).toEqual(CAPTIONS);
    expect(project.finishing?.sharpen).toMatchObject({ enabled: true, amount: 0.6 });
    expect(project.tracks?.length).toBeGreaterThan(0);
  });

  it('loads a saved project back as one history reset', async () => {
    act(() => {
      editorStore.getState().addClip(makeClip('a'));
      editorStore.getState().setCaptions(CAPTIONS);
      settingsStore.getState().setFinishing(FINISHING);
    });
    const download = captureDownload();
    await act(() => hook.current.handleSaveProject());
    const json = JSON.stringify(await download());

    // Start over, keep the media in the pool (matched by file name), then load.
    act(() => {
      __resetEditorStoreForTests();
      editorStore.getState().addClip(makeClip('a'));
      editorStore.getState().pushHistory();
      settingsStore.getState().setFinishing(DEFAULT_FINISHING);
    });
    hook.rerender();
    await act(() => hook.current.handleLoadProject(new File([json], 'project.json')));

    const state = editorStore.getState();
    expect(status()).toMatch(/^Project JSON loaded \(1 clips applied\)\.$/);
    expect(state.clips.map((c) => c.title)).toEqual(['a.mp4']);
    expect(state.clips[0]).toMatchObject({ trimStart: 0.5, trimEnd: 2.5 });
    expect(state.captions).toEqual(CAPTIONS);
    expect(state.selectedClipId).toBe(state.clips[0]!.id);
    expect(settingsStore.getState().finishing.sharpen).toMatchObject({ enabled: true, amount: 0.6 });
    expect(state.undoDepth).toBe(0);
  });

  it('reports a malformed project file and leaves the timeline alone', async () => {
    act(() => editorStore.getState().addClip(makeClip('a')));
    hook.rerender();
    const before = editorStore.getState().clips;
    await act(() => hook.current.handleLoadProject(new File(['{not json'], 'broken.json')));
    expect(status()).toMatch(/^Could not load project: /);
    expect(editorStore.getState().clips).toBe(before);
  });
});
