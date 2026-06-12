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

vi.mock('./canvas-encoder', () => ({
  encodeClipsWithCanvas: vi.fn(),
}));

vi.mock('../ffmpeg/ffmpegService', () => ({
  mergeClips: vi.fn(),
  calculateRenderPlan: vi.fn(),
  muxVideoWithAudio: vi.fn(),
}));

import { isWebCodecsAvailable, encodeVideoWithWebCodecs } from './webcodecs';
import { encodeClipsWithCanvas } from './canvas-encoder';
import { mergeClips, calculateRenderPlan, muxVideoWithAudio } from '../ffmpeg/ffmpegService';

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
      expect(encodeVideoWithWebCodecs).toHaveBeenCalled();
      expect(muxVideoWithAudio).toHaveBeenCalledWith(videoBlob, testClips, testSettings, mockStatusCallback, mockProgressCallback);
      expect(mergeClips).not.toHaveBeenCalled();
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

    it('should skip WebCodecs if text overlays are present', async () => {
      (isWebCodecsAvailable as any).mockResolvedValue(true);
      const mockBlob = new Blob(['ffmpeg video']);
      (mergeClips as any).mockResolvedValue(mockBlob);
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

      expect(result.path).toBe('ffmpeg');
      expect(encodeVideoWithWebCodecs).not.toHaveBeenCalled();
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
      );
      expect(result.renderPlan).toBe(mockRenderPlan);
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

      expect(result.renderPlan).toBe(providedRenderPlan);
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
