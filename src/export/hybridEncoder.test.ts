import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Clip, ClipTransition, RenderPlan, TextOverlay } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { hybridMergeClips } from './hybridEncoder';
import { DEFAULT_COLOR_MANAGEMENT } from '../finishing/colorManagement';

// Mock dependencies
vi.mock('./webcodecs', () => ({
  isWebCodecsAvailable: vi.fn(),
  encodeVideoWithWebCodecs: vi.fn(),
  encodeClipsWithWebCodecs: vi.fn(),
}));

vi.mock('./webcodecsAudio', () => ({
  isAudioEncoderAvailable: vi.fn(),
  assessWebCodecsAudioMix: vi.fn(),
  prepareStreamingAudioMix: vi.fn(),
}));

vi.mock('./canvasEncoder', () => ({
  encodeClipsWithCanvas: vi.fn(),
}));

vi.mock('../ffmpeg/ffmpegService', () => ({
  mergeClips: vi.fn(),
  calculateRenderPlan: vi.fn(),
  muxVideoWithAudio: vi.fn(),
}));

import { isWebCodecsAvailable, encodeVideoWithWebCodecs } from './webcodecs';
import {
  isAudioEncoderAvailable,
  assessWebCodecsAudioMix,
  prepareStreamingAudioMix,
} from './webcodecsAudio';
import { encodeClipsWithCanvas } from './canvasEncoder';
import { mergeClips, calculateRenderPlan, muxVideoWithAudio } from '../ffmpeg/ffmpegService';
import { DEFAULT_FINISHING } from '../finishing/finishing';

// Helper to create a minimal test clip
function createTestClip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration,
    videoWidth: 1920,
    videoHeight: 1080,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

/** A render-plan estimate carrying only the fields a test cares about. */
function renderPlan(fields: Partial<RenderPlan> = {}): RenderPlan {
  return fields as RenderPlan;
}

describe('export/hybridEncoder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAudioEncoderAvailable).mockResolvedValue(false);
    vi.mocked(assessWebCodecsAudioMix).mockReturnValue({ supported: true });
    vi.mocked(prepareStreamingAudioMix).mockResolvedValue(false);
    // A real calculateRenderPlan always returns a plan.
    vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());
    // Mock MediaRecorder for canvas tests
    vi.stubGlobal('MediaRecorder', vi.fn());
  });

  const mockStatusCallback = vi.fn();
  const mockProgressCallback = vi.fn();
  const testClips: [Clip, Clip] = [
    createTestClip('a', 5),
    createTestClip('b', 3),
  ];
  const testTransitions: ClipTransition[] = [];
  const testSettings = DEFAULT_EXPORT_SETTINGS;

  // =========================================================================
  // Canvas renderer path selection
  // =========================================================================
  describe('Canvas renderer path selection', () => {
    it('should use canvas renderer when requested', async () => {
      const mockBlob = new Blob(['video data']);
      vi.mocked(encodeClipsWithCanvas).mockResolvedValue(mockBlob);

      const result = await hybridMergeClips(
        testClips,
        testTransitions,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false, // forceFFmpeg
        [], // textOverlays
        true, // useCanvas
        true, // audioReactive
      );

      expect(result.path).toBe('canvas');
      expect(result.blob).toBe(mockBlob);
      expect(encodeClipsWithCanvas).toHaveBeenCalled();
    });

    it('should fall back to FFmpeg if canvas renderer fails', async () => {
      vi.mocked(encodeClipsWithCanvas).mockRejectedValue(new Error('Canvas error'));
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      const result = await hybridMergeClips(
        testClips,
        testTransitions,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false, // forceFFmpeg
        [], // textOverlays
        true, // useCanvas
      );

      expect(result.path).toBe('ffmpeg');
      expect(mergeClips).toHaveBeenCalled();
    });

    it('skips canvas and falls through to FFmpeg when finishing is active', async () => {
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);

      const activeFinishing = {
        ...DEFAULT_FINISHING,
        lut: { enabled: true, lutId: 'some-lut', intensity: 1 },
      };

      const result = await hybridMergeClips(
        testClips,
        testTransitions,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false, // forceFFmpeg
        [], // textOverlays
        true, // useCanvas
        true, // audioReactive
        false, // forceReencode
        undefined, // renderPlan
        [], // clipGroups
        activeFinishing,
      );

      expect(encodeClipsWithCanvas).not.toHaveBeenCalled();
      expect(result.path).toBe('ffmpeg');
      expect(mockStatusCallback).toHaveBeenCalledWith(
        expect.stringContaining('Canvas renderer skipped'),
      );
    });

    it('skips canvas when a clip is chroma/luma keyed', async () => {
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);

      const keyedClips = [
        createTestClip('a', 5, { overlayBlend: 'chroma', chromaKey: { color: '#00ff00', similarity: 0.4, blend: 0.1 } }),
        testClips[1],
      ];

      const result = await hybridMergeClips(
        keyedClips,
        testTransitions,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        true, // useCanvas
      );

      expect(encodeClipsWithCanvas).not.toHaveBeenCalled();
      expect(result.path).toBe('ffmpeg');
    });

    it('skips canvas when a PiP clip is present', async () => {
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);

      const pipClips = [testClips[0], { ...testClips[1], layerIndex: 1 }];

      const result = await hybridMergeClips(
        pipClips,
        testTransitions,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        true, // useCanvas
      );

      expect(encodeClipsWithCanvas).not.toHaveBeenCalled();
      expect(result.path).toBe('ffmpeg');
    });

    it('should pass audioReactive flag to canvas encoder', async () => {
      const mockBlob = new Blob(['video data']);
      vi.mocked(encodeClipsWithCanvas).mockResolvedValue(mockBlob);

      await hybridMergeClips(
        testClips,
        testTransitions,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        true,
        false, // audioReactive = false
      );

      expect(encodeClipsWithCanvas).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        false,
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // WebCodecs GPU path selection logic
  // =========================================================================
  describe('WebCodecs GPU path selection logic', () => {
    it('should use GPU path when rescaling is required and WebCodecs is available', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      const videoBlob = new Blob(['gpu video']);
      const finalBlob = new Blob(['muxed video']);
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(videoBlob);
      vi.mocked(muxVideoWithAudio).mockResolvedValue(finalBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(result.path).toBe('webcodecs');
      expect(encodeVideoWithWebCodecs).toHaveBeenCalledWith(
        testClips,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        'auto',
        [],
        [],
        [],
        expect.anything(),
        false,
        {},
        DEFAULT_COLOR_MANAGEMENT,
      );
      expect(muxVideoWithAudio).toHaveBeenCalledWith(
        videoBlob,
        testClips,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        [],
        [],
      );
      expect(mergeClips).not.toHaveBeenCalled();
    });

    it('should use webcodecs-av path when AudioEncoder and audio mix are supported', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      vi.mocked(isAudioEncoderAvailable).mockResolvedValue(true);
      vi.mocked(assessWebCodecsAudioMix).mockReturnValue({ supported: true });
      const avBlob = new Blob(['av mp4']);
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(avBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(result.path).toBe('webcodecs-av');
      expect(encodeVideoWithWebCodecs).toHaveBeenCalledWith(
        testClips,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        'auto',
        [],
        [],
        [],
        expect.anything(),
        true,
        {},
        DEFAULT_COLOR_MANAGEMENT,
      );
      expect(muxVideoWithAudio).not.toHaveBeenCalled();
      expect(result.blob).toBe(avBlob);
    });

    it('lifts the offline mix length cap when the streaming media engine is ready', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      vi.mocked(isAudioEncoderAvailable).mockResolvedValue(true);
      vi.mocked(prepareStreamingAudioMix).mockResolvedValue(true);
      vi.mocked(assessWebCodecsAudioMix).mockReturnValue({ supported: true });
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(new Blob(['av mp4']));
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
      );

      expect(result.path).toBe('webcodecs-av');
      expect(assessWebCodecsAudioMix).toHaveBeenCalledWith(testClips, [], [], {
        streamingMix: true,
      });
    });

    it('skips loading the media engine when AudioEncoder is unavailable', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      vi.mocked(isAudioEncoderAvailable).mockResolvedValue(false);
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(new Blob(['video']));
      vi.mocked(muxVideoWithAudio).mockResolvedValue(new Blob(['muxed']));
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      await hybridMergeClips(testClips, [], testSettings, mockStatusCallback, mockProgressCallback);

      expect(prepareStreamingAudioMix).not.toHaveBeenCalled();
      expect(assessWebCodecsAudioMix).toHaveBeenCalledWith(testClips, [], [], {
        streamingMix: false,
      });
    });

    it('burns captions into the GPU composite and reports it', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      vi.mocked(isAudioEncoderAvailable).mockResolvedValue(true);
      vi.mocked(assessWebCodecsAudioMix).mockReturnValue({ supported: true });
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(new Blob(['av mp4']));
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const captions = [
        { id: 'c1', startSec: 0, endSec: 2, text: 'hello' },
      ];
      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
        true,
        false,
        undefined,
        [],
        undefined,
        null,
        { captions, captionStyle: { fontsize: 42 } },
      );

      // The caller reads this to skip the FFmpeg burn-in post-pass, which
      // would otherwise burn a second copy and cost a full re-encode.
      expect(result.captionsBurnedIn).toBe(true);
      const call = vi.mocked(encodeVideoWithWebCodecs).mock.calls[0]!;
      expect(call[10]).toEqual({ captions, captionStyle: { fontsize: 42 } });
    });

    it('does not claim a burn-in when there are no cues', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      vi.mocked(isAudioEncoderAvailable).mockResolvedValue(true);
      vi.mocked(assessWebCodecsAudioMix).mockReturnValue({ supported: true });
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(new Blob(['av mp4']));
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
        true,
        false,
        undefined,
        [],
        undefined,
        null,
        { captions: [] },
      );

      expect(result.captionsBurnedIn).toBe(false);
      expect(vi.mocked(encodeVideoWithWebCodecs).mock.calls[0]![10]).toEqual({});
    });

    it('should use FFmpeg lossless when clips already match export resolution', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: false, path: 'lossless-concat' }));
      const matchedClips = [
        createTestClip('a', 5, { videoWidth: 1920, videoHeight: 1080 }),
        createTestClip('b', 3, { videoWidth: 1920, videoHeight: 1080 }),
      ];

      const result = await hybridMergeClips(
        matchedClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(result.path).toBe('ffmpeg');
      expect(encodeVideoWithWebCodecs).not.toHaveBeenCalled();
      expect(mergeClips).toHaveBeenCalled();
    });

    it('should fall back to FFmpeg when GPU encode fails', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      vi.mocked(encodeVideoWithWebCodecs).mockRejectedValue(new Error('GPU encoder failed'));
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(result.path).toBe('ffmpeg');
      expect(mergeClips).toHaveBeenCalled();
      expect(mockStatusCallback).toHaveBeenCalledWith(
        expect.stringContaining('GPU encode failed (GPU encoder failed'),
      );
    });

    it('should skip WebCodecs if transitions are present', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: 'dissolve', duration: 0.5 },
      ];

      const result = await hybridMergeClips(
        testClips,
        transitions,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(result.path).toBe('ffmpeg');
      expect(encodeVideoWithWebCodecs).not.toHaveBeenCalled();
    });

    it('should use WebCodecs decoder path when solid text overlays are present', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      const videoBlob = new Blob(['gpu video']);
      const finalBlob = new Blob(['muxed video']);
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(videoBlob);
      vi.mocked(muxVideoWithAudio).mockResolvedValue(finalBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const textOverlays: TextOverlay[] = [
        {
          id: 'text1',
          text: 'Hello',
          fontsize: 40,
          fontcolor: '#ffffff',
          x: 50,
          y: 650,
          scrolling: false,
          scrollSpeed: 100,
          box: false,
          boxColor: 'black@0.5',
        },
      ];

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        textOverlays,
        false,
      );

      expect(result.path).toBe('webcodecs');
      expect(encodeVideoWithWebCodecs).toHaveBeenCalledWith(
        testClips,
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        'auto',
        [],
        textOverlays,
        [],
        expect.anything(),
        false,
        {},
        DEFAULT_COLOR_MANAGEMENT,
      );
      expect(mergeClips).not.toHaveBeenCalled();
    });

    it('should skip WebCodecs if PiP overlays are present', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      const clipsWithPiP = [
        testClips[0],
        { ...testClips[1], layerIndex: 1 },
      ];

      const result = await hybridMergeClips(
        clipsWithPiP,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(result.path).toBe('ffmpeg');
      expect(encodeVideoWithWebCodecs).not.toHaveBeenCalled();
    });

    it('should skip WebCodecs if RIFE-processed clips are present', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      const clipsWithRife = [
        { ...testClips[0], rifeProcessed: true },
      ];

      const result = await hybridMergeClips(
        clipsWithRife,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(result.path).toBe('ffmpeg');
      expect(encodeVideoWithWebCodecs).not.toHaveBeenCalled();
    });

    it('should force FFmpeg when forceFFmpeg flag is set', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        true, // forceFFmpeg = true
        [],
        false,
      );

      expect(result.path).toBe('ffmpeg');
      expect(encodeVideoWithWebCodecs).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // FFmpeg path (default / fallback)
  // =========================================================================
  describe('FFmpeg path (default / fallback)', () => {
    it('should use FFmpeg when WebCodecs is not available', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
      );

      expect(result.path).toBe('ffmpeg');
      expect(mergeClips).toHaveBeenCalled();
    });

    it('should calculate render plan if not provided', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      const mockRenderPlan = renderPlan({ reason: 'mock estimate' });
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(mockRenderPlan);

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
        true,
        false, // forceReencode
        undefined, // no renderPlan provided
      );

      expect(calculateRenderPlan).toHaveBeenCalledWith(
        testClips,
        [],
        [],
        testSettings,
        expect.objectContaining({
          finishing: DEFAULT_FINISHING,
          forceFFmpeg: false,
          useCanvasRenderer: false,
        }),
      );
      expect(result.renderPlan).toEqual({
        ...mockRenderPlan,
        encoderIntent: 'ffmpeg',
        encoderReasons: ['Nothing to re-encode — FFmpeg stream-copies (lossless concat)'],
      });
    });

    it('should use provided render plan', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      const providedRenderPlan = renderPlan({ description: 'cached plan' });
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
        true,
        false,
        providedRenderPlan,
      );

      expect(result.renderPlan).toEqual({
        ...providedRenderPlan,
        encoderIntent: 'ffmpeg',
        encoderReasons: ['Nothing to re-encode — FFmpeg stream-copies (lossless concat)'],
      });
      expect(calculateRenderPlan).not.toHaveBeenCalled();
    });

    it('should pass forceReencode to mergeClips', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
        true,
        true, // forceReencode = true
      );

      expect(mergeClips).toHaveBeenCalledWith(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        [],
        mockProgressCallback,
        true, // forceReencode passed through
        DEFAULT_FINISHING,
        null,
      );
    });
  });

  // =========================================================================
  // Status and progress callbacks
  // =========================================================================
  describe('Status and progress callbacks', () => {
    it('should call onStatus with canvas selection message', async () => {
      const mockBlob = new Blob(['video data']);
      vi.mocked(encodeClipsWithCanvas).mockResolvedValue(mockBlob);

      await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        true,
      );

      expect(mockStatusCallback).toHaveBeenCalledWith(
        expect.stringContaining('Canvas renderer path selected'),
      );
    });

    it('should call onStatus with GPU selection message when rescaling', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(true);
      vi.mocked(encodeVideoWithWebCodecs).mockResolvedValue(new Blob(['gpu video']));
      vi.mocked(muxVideoWithAudio).mockResolvedValue(new Blob(['muxed video']));
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan({ willReencode: true }));

      await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(mockStatusCallback).toHaveBeenCalledWith(
        expect.stringContaining('GPU path selected'),
      );
    });

    it('should call onProgress callbacks', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
        false,
        [],
        false,
      );

      expect(mockProgressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: expect.any(String),
          progress: expect.any(Number),
          indeterminate: expect.any(Boolean),
        }),
      );
    });
  });

  // =========================================================================
  // Return value structure
  // =========================================================================
  describe('Return value structure', () => {
    it('should return HybridEncodeResult with blob and path', async () => {
      vi.mocked(isWebCodecsAvailable).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      vi.mocked(mergeClips).mockResolvedValue(mockBlob);
      vi.mocked(calculateRenderPlan).mockReturnValue(renderPlan());

      const result = await hybridMergeClips(
        testClips,
        [],
        testSettings,
        mockStatusCallback,
        mockProgressCallback,
      );

      expect(result).toHaveProperty('blob');
      expect(result).toHaveProperty('path');
      expect(['canvas', 'webcodecs', 'ffmpeg']).toContain(result.path);
      expect(result.blob instanceof Blob).toBe(true);
    });
  });
});
