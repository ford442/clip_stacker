import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { CaptionEntry, Clip, MasterAudio, SyncMarker } from '../types';
import { DEFAULT_FINISHING, DEFAULT_SHARPEN, type FinishingSettings } from '../utils/finishing';
import { DEFAULT_COLOR_MANAGEMENT, type ColorManagementSettings } from '../utils/colorManagement';
import type { MasterBusSettings } from '../utils/audioBus';
import { AUTO_SAVE_DEBOUNCE_MS, AUTO_SAVE_STORAGE_KEY, readAutoSaveSession } from '../utils/autoSave';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { useAutoSave } from './useAutoSave';

// happy-dom cannot decode media; recovery only needs a duration back.
vi.mock('../utils/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/media')>()),
  getMediaInfo: vi.fn(async (file: File) => ({
    duration: 2,
    objectUrl: URL.createObjectURL(file),
  })),
}));

type Hook = ReturnType<typeof useAutoSave>;

function makeClip(id: string): Clip {
  const file = new File([new Uint8Array(32)], `${id}.mp4`, { type: 'video/mp4' });
  return {
    id,
    file,
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 2,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

function makeMasterAudio(): MasterAudio {
  const file = new File([new Uint8Array(64)], 'song.mp3', { type: 'audio/mpeg' });
  return { file, objectUrl: 'blob:song', fileName: 'song.mp3', duration: 30, startTime: 1.5 };
}

const CAPTIONS: CaptionEntry[] = [{ id: 'c1', startSec: 0.5, endSec: 1.5, text: 'Hello' }];
const MARKERS: SyncMarker[] = [{ id: 'm1', time: 4, text: 'drop' }];
const MASTER_BUS: MasterBusSettings = { loudness: { targetLufs: -14, truePeakDb: -1 } };
const COLOR: ColorManagementSettings = { outputColor: 'display-p3', workingSpace: 'rec2020-linear' };
const FINISHING: FinishingSettings = {
  ...DEFAULT_FINISHING,
  sharpen: { ...DEFAULT_SHARPEN, enabled: true, amount: 0.7 },
};

function resetStores(): void {
  __resetEditorStoreForTests();
  settingsStore.getState().setFinishing(DEFAULT_FINISHING);
  settingsStore.getState().setColorManagement(DEFAULT_COLOR_MANAGEMENT);
  settingsStore.getState().setStatus('');
}

describe('useAutoSave', () => {
  let root: Root | null = null;
  let hook: Hook | null = null;

  function Probe() {
    hook = useAutoSave({ resetHistory: editorStore.getState().resetHistory });
    return null;
  }

  async function mount() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  }

  function unmount() {
    act(() => root?.unmount());
    root = null;
    hook = null;
  }

  /** Let the debounce fire and the async save finish. */
  async function flushSave(previous: string | null = null) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS + 10);
    });
    await vi.waitFor(() => {
      const raw = localStorage.getItem(AUTO_SAVE_STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(raw).not.toBe(previous);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    unmount();
    vi.useRealTimers();
    localStorage.clear();
    resetStores();
  });

  it('round-trips finishing, master audio, master bus, captions and colour management', async () => {
    const editor = editorStore.getState();
    editor.setClips([makeClip('a')]);
    editor.setCaptions(CAPTIONS);
    editor.setMasterAudio(makeMasterAudio());
    editor.setMasterAudioMarkers(MARKERS);
    editor.setMasterBus(MASTER_BUS);
    settingsStore.getState().setFinishing(FINISHING);
    settingsStore.getState().setColorManagement(COLOR);

    await mount();
    await flushSave();
    const saved = readAutoSaveSession()!.project;
    expect(saved.finishing?.sharpen?.amount).toBe(0.7);
    expect(saved.masterAudio?.fileName).toBe('song.mp3');
    expect(saved.masterAudio?.sourceMediaDataUrl).toMatch(/^data:audio\/mpeg;base64,/);
    expect(saved.masterAudioMarkers).toEqual(MARKERS);

    // "Reload": a fresh page with empty stores and the autosave on disk.
    // Recovery downloads the embedded media, which needs real timers.
    unmount();
    vi.useRealTimers();
    resetStores();
    await mount();
    expect(hook!.recoveryOffer).not.toBeNull();
    await act(async () => {
      await hook!.handleRecover();
    });

    const state = editorStore.getState();
    expect(state.clips.map((c) => c.id)).toEqual(['a']);
    expect(state.captions).toEqual(CAPTIONS);
    expect(state.masterAudio?.fileName).toBe('song.mp3');
    expect(state.masterAudio?.startTime).toBe(1.5);
    expect(state.masterAudioMarkers).toEqual(MARKERS);
    expect(state.masterBus).toEqual(MASTER_BUS);
    expect(settingsStore.getState().finishing.sharpen).toEqual(FINISHING.sharpen);
    expect(settingsStore.getState().colorManagement).toEqual(COLOR);
  });

  it('saves a grade-only edit', async () => {
    editorStore.getState().setClips([makeClip('a')]);
    await mount();
    await flushSave();
    const before = localStorage.getItem(AUTO_SAVE_STORAGE_KEY);
    expect(readAutoSaveSession()!.project.finishing).toBeUndefined();

    await act(async () => {
      settingsStore.getState().setFinishing(FINISHING);
    });
    await flushSave(before);
    expect(readAutoSaveSession()!.project.finishing?.sharpen?.enabled).toBe(true);
  });

  it('keeps a project that only has captions', async () => {
    editorStore.getState().setCaptions(CAPTIONS);
    await mount();
    await flushSave();
    expect(readAutoSaveSession()!.project.captions).toHaveLength(1);
  });

  it('keeps a project that only has a master track', async () => {
    editorStore.getState().setMasterAudio(makeMasterAudio());
    await mount();
    await flushSave();
    expect(readAutoSaveSession()!.project.masterAudio?.fileName).toBe('song.mp3');
  });

  it('clears the autosave once the project is truly empty', async () => {
    localStorage.setItem(AUTO_SAVE_STORAGE_KEY, 'stale');
    // No recoverable work in 'stale', so there is no offer and saving runs.
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_SAVE_DEBOUNCE_MS + 10);
    });
    expect(localStorage.getItem(AUTO_SAVE_STORAGE_KEY)).toBeNull();
  });
});
