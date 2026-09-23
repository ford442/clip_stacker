import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Clip, ClipTransition, TextOverlay } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { hybridMergeClips } from './hybrid-encoder';

// Mock dependencies
vi.mock('./webcodecs', () => ({
  isWebCodecsAvailable: vi.fn(),
  encodeVideoWithWebCodecs: vi.fn(),
  encodeClipsWithWebCodecs: vi.fn(),
}));

vi.mock('./webcodecs-audio', () => ({
  isAudioEncoderAvailable: vi.fn(),
  assessWebCodecsAudioMix: vi.fn(),
  prepareStreamingAudioMix: vi.fn(),
}));

vi.mock('./canvas-encoder', () => ({
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
} from './webcodecs-audio';
import { encodeClipsWithCanvas } from './canvas-encoder';
import { mergeClips, calculateRenderPlan, muxVideoWithAudio } from '../ffmpeg/ffmpegService';
import { DEFAULT_FINISHING } from './finishing';

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

describe('utils/hybrid-encoder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isAudioEncoderAvailable as any).mockResolvedValue(false);
    (assessWebCodecsAudioMix as any).mockReturnValue({ supported: true });
    (prepareStreamingAudioMix as any).mockResolvedValue(false);
    // Mock MediaRecorder for canvas tests
    (global as any).MediaRecorder = vi.fn();
  });

  const mockStatusCallback = vi.fn();
  const mockProgressCallback = vi.fn();
  const testClips = [
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
      (encodeClipsWithCanvas as any).mockResolvedValue(mockBlob);

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
      (encodeClipsWithCanvas as any).mockRejectedValue(new Error('Canvas error'));
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});
      (isWebCodecsAvailable as any).mockResolvedValue(false);

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
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});
      (isWebCodecsAvailable as any).mockResolvedValue(false);

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
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});
      (isWebCodecsAvailable as any).mockResolvedValue(false);

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
      (encodeClipsWithCanvas as any).mockResolvedValue(mockBlob);

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const videoBlob = new Blob(['gpu video']);
      const finalBlob = new Blob(['muxed video']);
      (encodeVideoWithWebCodecs as any).mockResolvedValue(videoBlob);
      (muxVideoWithAudio as any).mockResolvedValue(finalBlob);
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      (isAudioEncoderAvailable as any).mockResolvedValue(true);
      (assessWebCodecsAudioMix as any).mockReturnValue({ supported: true });
      const avBlob = new Blob(['av mp4']);
      (encodeVideoWithWebCodecs as any).mockResolvedValue(avBlob);
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      );
      expect(muxVideoWithAudio).not.toHaveBeenCalled();
      expect(result.blob).toBe(avBlob);
    });

    it('lifts the offline mix length cap when the streaming media engine is ready', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      (isAudioEncoderAvailable as any).mockResolvedValue(true);
      (prepareStreamingAudioMix as any).mockResolvedValue(true);
      (assessWebCodecsAudioMix as any).mockReturnValue({ supported: true });
      (encodeVideoWithWebCodecs as any).mockResolvedValue(new Blob(['av mp4']));
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      (isAudioEncoderAvailable as any).mockResolvedValue(false);
      (encodeVideoWithWebCodecs as any).mockResolvedValue(new Blob(['video']));
      (muxVideoWithAudio as any).mockResolvedValue(new Blob(['muxed']));
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

      await hybridMergeClips(testClips, [], testSettings, mockStatusCallback, mockProgressCallback);

      expect(prepareStreamingAudioMix).not.toHaveBeenCalled();
      expect(assessWebCodecsAudioMix).toHaveBeenCalledWith(testClips, [], [], {
        streamingMix: false,
      });
    });

    it('burns captions into the GPU composite and reports it', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      (isAudioEncoderAvailable as any).mockResolvedValue(true);
      (assessWebCodecsAudioMix as any).mockReturnValue({ supported: true });
      (encodeVideoWithWebCodecs as any).mockResolvedValue(new Blob(['av mp4']));
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      const call = (encodeVideoWithWebCodecs as any).mock.calls[0];
      expect(call[10]).toEqual({ captions, captionStyle: { fontsize: 42 } });
    });

    it('does not claim a burn-in when there are no cues', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      (isAudioEncoderAvailable as any).mockResolvedValue(true);
      (assessWebCodecsAudioMix as any).mockReturnValue({ supported: true });
      (encodeVideoWithWebCodecs as any).mockResolvedValue(new Blob(['av mp4']));
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      expect((encodeVideoWithWebCodecs as any).mock.calls[0][10]).toEqual({});
    });

    it('should use FFmpeg lossless when clips already match export resolution', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({ willReencode: false, path: 'lossless-concat' });
      const matchedClips = [
        createTestClip('a', 5, { videoWidth: 1280, videoHeight: 720 }),
        createTestClip('b', 3, { videoWidth: 1280, videoHeight: 720 }),
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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      (encodeVideoWithWebCodecs as any).mockRejectedValue(new Error('GPU encoder failed'));
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const videoBlob = new Blob(['gpu video']);
      const finalBlob = new Blob(['muxed video']);
      (encodeVideoWithWebCodecs as any).mockResolvedValue(videoBlob);
      (muxVideoWithAudio as any).mockResolvedValue(finalBlob);
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      );
      expect(mergeClips).not.toHaveBeenCalled();
    });

    it('should skip WebCodecs if PiP overlays are present', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      (isWebCodecsAvailable as any).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
      (isWebCodecsAvailable as any).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      const mockRenderPlan = { someKey: 'someValue' };
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue(mockRenderPlan);

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
      expect(result.renderPlan).toEqual({ ...mockRenderPlan, encoderIntent: 'ffmpeg' });
    });

    it('should use provided render plan', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      const providedRenderPlan = { cached: 'plan' };
      (mergeClips as any).mockResolvedValue(mockBlob);

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
        providedRenderPlan as any,
      );

      expect(result.renderPlan).toEqual({ ...providedRenderPlan, encoderIntent: 'ffmpeg' });
      expect(calculateRenderPlan).not.toHaveBeenCalled();
    });

    it('should pass forceReencode to mergeClips', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
      (encodeClipsWithCanvas as any).mockResolvedValue(mockBlob);

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
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      (encodeVideoWithWebCodecs as any).mockResolvedValue(new Blob(['gpu video']));
      (muxVideoWithAudio as any).mockResolvedValue(new Blob(['muxed video']));
      (calculateRenderPlan as any).mockReturnValue({ willReencode: true });

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
      (isWebCodecsAvailable as any).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
      (isWebCodecsAvailable as any).mockResolvedValue(false);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
      (calculateRenderPlan as any).mockReturnValue({});

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
