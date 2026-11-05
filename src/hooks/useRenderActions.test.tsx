/**
 * useRenderActions: the Render button's state machine around the encoder
 * (`hybridMergeClips` and the FFmpeg service are mocked — their own suites
 * cover encoding). What is tested here is the hook's part: which clips and
 * options reach the encoder, the job state it leaves behind on success and
 * failure, the memory-warning gate, and caption burn-in routing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { renderJobStore } from '../store/renderJobStore';
import { reorderMainTrackClips } from '../timeline/trackModel';
import { useEditHistory } from './useEditHistory';
import { useRenderActions } from './useRenderActions';
import { act, renderHook, type RenderedHook } from './renderHook.test.helpers';

const pipeline = vi.hoisted(() => ({
  hybridMergeClips: vi.fn(),
  applyCaptionsToRenderedVideo: vi.fn(async (blob: Blob, _captions: unknown, _options: { mode: string }) => blob),
  finalizeRenderedVideo: vi.fn(async (blob: Blob) => blob),
  isFfmpegLoadFailed: vi.fn(() => false),
  aggressiveCleanupFFmpegVFS: vi.fn(async () => undefined),
  isHighMemoryUsage: vi.fn(() => false),
}));

vi.mock('../ffmpeg/ffmpegService', () => ({
  calculateRenderPlan: () => ({ description: 'GPU encode', reason: 'test plan' }),
  isFfmpegLoading: () => false,
  finalizeRenderedVideo: pipeline.finalizeRenderedVideo,
  getLastFfmpegLogs: () => [],
  isFfmpegLoadFailed: pipeline.isFfmpegLoadFailed,
  aggressiveCleanupFFmpegVFS: pipeline.aggressiveCleanupFFmpegVFS,
}));
vi.mock('../export/hybridEncoder', () => ({ hybridMergeClips: pipeline.hybridMergeClips }));
vi.mock('../ffmpeg/captions', () => ({ applyCaptionsToRenderedVideo: pipeline.applyCaptionsToRenderedVideo }));
vi.mock('../webgpu/exportCompositor', () => ({ isWebGpuExportAvailable: async () => true }));
vi.mock('../actions/debugReport', () => ({ generateDebugReport: () => 'report' }));
vi.mock('../utils/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/memory')>()),
  isHighMemoryUsage: pipeline.isHighMemoryUsage,
}));

function makeClip(id: string): Clip {
  return {
    id,
    file: new File([new Uint8Array(16)], `${id}.mp4`, { type: 'video/mp4' }),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 3,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

type Actions = ReturnType<typeof useRenderActions>;

function useProbe(): Actions {
  const { clips, tracks, clipGroups, transitions, textOverlays } = useEditHistory();
  return useRenderActions({ clips, tracks, clipGroups, transitions, textOverlays });
}

const job = () => renderJobStore.getState();
const mergeArgs = () => pipeline.hybridMergeClips.mock.calls[0]!;

describe('useRenderActions', () => {
  let hook: RenderedHook<Actions>;

  beforeEach(() => {
    __resetEditorStoreForTests();
    settingsStore.getState().setCaptionExportMode('none');
    job().setStatus('');
    job().setOutputUrl(null);
    job().setEncoderPath('');
    vi.clearAllMocks();
    pipeline.hybridMergeClips.mockResolvedValue({
      blob: new Blob(['mp4'], { type: 'video/mp4' }),
      path: 'webcodecs',
      captionsBurnedIn: false,
    });
    hook = renderHook(useProbe);
  });

  afterEach(() => hook.unmount());

  function addClips(...ids: string[]): void {
    act(() => {
      for (const id of ids) editorStore.getState().addClip(makeClip(id));
    });
  }

  it('refuses an empty timeline without loading the pipeline', async () => {
    await act(() => hook.current.performRender());
    expect(job().status).toBe('Upload clips before rendering.');
    expect(pipeline.hybridMergeClips).not.toHaveBeenCalled();
  });

  it('renders the clips in lane order and leaves a finished job', async () => {
    addClips('a', 'b');
    // Swap the base lane: the export must follow the tracks, not the pool.
    act(() => {
      const { tracks, clips, transitions } = editorStore.getState();
      editorStore.getState().setTracks(reorderMainTrackClips(tracks, clips, transitions, 1, 0));
    });
    await act(() => hook.current.performRender());

    expect(mergeArgs()[0].map((c: Clip) => c.id)).toEqual(['b', 'a']);
    expect(job().outputUrl).toMatch(/^blob:/);
    expect(job().encoderPath).toBe('webcodecs');
    expect(job().isRendering).toBe(false);
    expect(job().progressValue).toBe(1);
    expect(job().status).toMatch(/^Render complete via .*MP4\.$/);
    expect(hook.current.renderFailureMessage).toBeNull();
    expect(pipeline.aggressiveCleanupFFmpegVFS).toHaveBeenCalledOnce();
  });

  it('reports a failure, keeps no output and flags an FFmpeg load failure', async () => {
    addClips('a');
    pipeline.hybridMergeClips.mockRejectedValue(new Error('encoder exploded'));
    pipeline.isFfmpegLoadFailed.mockReturnValue(true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(() => hook.current.performRender());
    consoleError.mockRestore();

    expect(job().status).toBe('Render failed: encoder exploded');
    expect(hook.current.renderFailureMessage).toBe('Render failed: encoder exploded');
    expect(job().outputUrl).toBeNull();
    expect(job().isRendering).toBe(false);
    expect(job().ffmpegFailed).toBe(true);
    expect(pipeline.aggressiveCleanupFFmpegVFS).toHaveBeenCalledOnce();
  });

  it('holds a high-memory render behind the warning until confirmed', async () => {
    addClips('a');
    pipeline.isHighMemoryUsage.mockReturnValue(true);
    await act(() => hook.current.handleMerge());
    expect(hook.current.showMemoryWarning).toBe(true);
    expect(pipeline.hybridMergeClips).not.toHaveBeenCalled();

    act(() => hook.current.handleMemoryWarningCancel());
    expect(hook.current.showMemoryWarning).toBe(false);
    expect(job().status).toBe('Render cancelled.');

    await act(() => hook.current.handleMerge());
    await act(async () => {
      hook.current.handleMemoryWarningConfirm();
      await vi.waitFor(() => expect(job().outputUrl).not.toBeNull());
    });
    expect(pipeline.hybridMergeClips).toHaveBeenCalledOnce();
  });

  it('hands burn-in captions to the compositor and skips the post-pass burn', async () => {
    addClips('a');
    act(() => {
      editorStore.getState().setCaptions([{ id: 'c1', startSec: 0, endSec: 1, text: 'Hi' }]);
      settingsStore.getState().setCaptionExportMode('burn');
    });
    pipeline.hybridMergeClips.mockResolvedValue({ blob: new Blob(['mp4']), path: 'webcodecs', captionsBurnedIn: true });
    await act(() => hook.current.performRender());

    const captionBurnIn = mergeArgs()[14];
    expect(captionBurnIn?.captions).toHaveLength(1);
    expect(pipeline.applyCaptionsToRenderedVideo.mock.calls[0]![2].mode).toBe('none');
  });

  it('leaves captions to the post-pass when the encoder did not burn them', async () => {
    addClips('a');
    act(() => {
      editorStore.getState().setCaptions([{ id: 'c1', startSec: 0, endSec: 1, text: 'Hi' }]);
      settingsStore.getState().setCaptionExportMode('soft');
    });
    await act(() => hook.current.performRender());
    expect(mergeArgs()[14]).toBeNull();
    expect(pipeline.applyCaptionsToRenderedVideo.mock.calls[0]![2].mode).toBe('soft');
  });
});
