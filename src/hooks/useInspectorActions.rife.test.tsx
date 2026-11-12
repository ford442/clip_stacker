/**
 * Single-clip "Send to RIFE": the cleanup checkboxes ride along in the same
 * job, after the clip's audio is back under RIFE's silent video.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { renderJobStore } from '../store/renderJobStore';
import { useEditHistory } from './useEditHistory';
import { useInspectorActions } from './useInspectorActions';
import { renderHook, act, type RenderedHook } from './renderHook.test.helpers';

const calls: string[] = [];
const finalize = vi.fn(async (blob: Blob, settings: unknown) => {
  calls.push('finalize');
  void settings;
  return new Blob([blob], { type: 'video/quicktime' });
});

vi.mock('../ffmpeg/ffmpegService', () => ({
  extractTrimmedVideoClip: vi.fn(async () => new Blob(['trim'], { type: 'video/mp4' })),
  muxProcessedVideoWithSourceAudio: vi.fn(async (blob: Blob) => {
    calls.push('mux');
    return blob;
  }),
  finalizeRenderedVideo: (blob: Blob, settings: unknown) => finalize(blob, settings),
}));
vi.mock('../remote/huggingface', () => ({
  processClipWithRIFE: vi.fn(async () => ({ blob: new Blob(['rife'], { type: 'video/mp4' }) })),
}));
vi.mock('../media/media', () => ({
  getMediaInfo: vi.fn(async () => ({ duration: 2 })),
}));

function makeClip(id: string): Clip {
  return {
    id,
    file: new File([new Uint8Array(16)], `${id}.mp4`, { type: 'video/mp4' }),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 4,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

function useProbe() {
  const history = useEditHistory();
  return useInspectorActions({ ...history, clips: history.clips, selectedClipId: 'a' });
}

describe('handleRife cleanup', () => {
  let hook: RenderedHook<ReturnType<typeof useProbe>>;

  beforeEach(() => {
    calls.length = 0;
    finalize.mockClear();
    __resetEditorStoreForTests();
    editorStore.getState().addClip(makeClip('a'));
    renderJobStore.getState().setRifeProcessingClipId(null);
    hook = renderHook(useProbe);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:out', revokeObjectURL: () => {} }));
  });

  afterEach(() => {
    hook.unmount();
    vi.unstubAllGlobals();
  });

  it('runs the selected cleanup after the audio mux, in the chosen format', async () => {
    await act(async () => {
      await hook.current.handleRife('interpolation', 2, 'prores', {
        lightVideoCleanup: true,
        audioCleanup: false,
      });
    });
    expect(calls).toEqual(['mux', 'finalize']);
    expect(finalize.mock.calls[0][1]).toMatchObject({
      outputFormat: 'prores',
      lightVideoCleanup: true,
      audioCleanup: false,
    });
    expect(editorStore.getState().clips[0].file.name).toBe('rife_2x_a.mov');
  });

  it('skips the extra pass when no cleanup is selected', async () => {
    await act(async () => {
      await hook.current.handleRife('interpolation', 2, 'mp4', {
        lightVideoCleanup: false,
        audioCleanup: false,
      });
    });
    expect(calls).toEqual(['mux']);
  });
});
