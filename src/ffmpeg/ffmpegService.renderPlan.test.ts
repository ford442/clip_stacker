import { describe, it, expect } from "vitest";
import type { Clip, ClipStabilization, TextOverlay } from "../types";
import { DEFAULT_EXPORT_SETTINGS } from "../types";
import { calculateRenderPlan } from "./ffmpegService";
import { DEFAULT_FINISHING } from "../utils/finishing";
import { createSecondaryGrade } from "../utils/secondaryColor";

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "clip-1",
    file: new File([], "clip-1.mp4"),
    objectUrl: "blob:clip-1",
    title: "Clip 1",
    kind: "video",
    duration: 5,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

function makeOverlay(overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "overlay-1",
    text: "Hello",
    fontsize: 32,
    fontcolor: "white",
    x: 0,
    y: 0,
    scrolling: false,
    scrollSpeed: 0,
    box: false,
    boxColor: "black@0.5",
    ...overrides,
  };
}

describe("calculateRenderPlan", () => {
  it("forces re-encoding when a clip is RIFE-processed", () => {
    const clip = makeClip({ title: "RIFE Clip", rifeProcessed: true });

    const plan = calculateRenderPlan([clip], [], [], DEFAULT_EXPORT_SETTINGS);

    expect(plan.path).toBe("effects-reencoding");
    expect(plan.willReencode).toBe(true);
    expect(plan.reason).toContain("RIFE-processed");
  });

  it('forces re-encoding when a clip has loopCount > 1', () => {
    const clip = makeClip({
      title: 'Looped Clip',
      videoWidth: 1280,
      videoHeight: 720,
      loopCount: 4,
    });

    const plan = calculateRenderPlan([clip], [], [], DEFAULT_EXPORT_SETTINGS);

    expect(plan.path).toBe('effects-reencoding');
    expect(plan.willReencode).toBe(true);
    expect(plan.reason).toContain('looped 4×');
  });

  it('does not force re-encoding for loopCount 1 (default, matches current behavior)', () => {
    const clips = [
      makeClip({ videoWidth: 1280, videoHeight: 720, loopCount: 1 }),
      makeClip({ id: 'clip-2', title: 'Clip 2', videoWidth: 1280, videoHeight: 720 }),
    ];

    const plan = calculateRenderPlan(clips, [], [], DEFAULT_EXPORT_SETTINGS);

    expect(plan.path).toBe('lossless-concat');
    expect(plan.willReencode).toBe(false);
  });

  it('uses lossless concat when fixed resolution already matches all clips', () => {
    const clips = [
      makeClip({ videoWidth: 1280, videoHeight: 720 }),
      makeClip({ id: 'clip-2', title: 'Clip 2', videoWidth: 1280, videoHeight: 720 }),
    ];

    const plan = calculateRenderPlan(clips, [], [], DEFAULT_EXPORT_SETTINGS);

    expect(plan.path).toBe('lossless-concat');
    expect(plan.willReencode).toBe(false);
    expect(plan.reason).toContain('already match');
  });

  it('forces re-encoding when a still image is in the timeline', () => {
    const still = makeClip({
      title: 'Photo.png',
      stillImage: true,
      file: new File([], 'Photo.png', { type: 'image/png' }),
      videoWidth: 1920,
      videoHeight: 1080,
    });

    const plan = calculateRenderPlan([still], [], [], DEFAULT_EXPORT_SETTINGS);

    expect(plan.path).toBe('effects-reencoding');
    expect(plan.willReencode).toBe(true);
    expect(plan.reason).toContain('Still image');
  });

  it('forces re-encoding when clips have mixed native resolutions', () => {
    const clips = [
      makeClip({ videoWidth: 1920, videoHeight: 1080 }),
      makeClip({ id: 'clip-2', title: 'Clip 2', videoWidth: 1280, videoHeight: 720 }),
    ];

    const plan = calculateRenderPlan(
      clips,
      [],
      [],
      { ...DEFAULT_EXPORT_SETTINGS, resolutionPreset: 'original', outputResolution: 'original' },
    );

    expect(plan.path).toBe('effects-reencoding');
    expect(plan.willReencode).toBe(true);
    expect(plan.reason).toContain('different native resolutions');
  });

  it('lists shader-filled text overlays on the render plan', () => {
    const clip = makeClip();
    const shaderOverlay = makeOverlay({ id: 'shader-1', text: 'Plasma title', fill: 'shader', shaderId: 'plasma' });
    const solidOverlay = makeOverlay({ id: 'solid-1', text: 'Caption' });

    const plan = calculateRenderPlan([clip], [], [shaderOverlay, solidOverlay], DEFAULT_EXPORT_SETTINGS);

    expect(plan.shaderTextOverlays).toEqual([{ id: 'shader-1', text: 'Plasma title' }]);
    expect(plan.shaderTextFallbackApplied).toBeUndefined();
  });

  it('omits shaderTextOverlays when no overlay uses a shader fill', () => {
    const clip = makeClip();
    const solidOverlay = makeOverlay();

    const plan = calculateRenderPlan([clip], [], [solidOverlay], DEFAULT_EXPORT_SETTINGS);

    expect(plan.shaderTextOverlays).toBeUndefined();
  });

  describe('routing-honesty fields (encoderIntent / finishing / stabilize / keying / captions)', () => {
    function makeStabilization(overrides: Partial<ClipStabilization> = {}): ClipStabilization {
      return {
        fps: 24,
        matrices: new Float32Array([1, 0, 0, 0, 1, 0]),
        frameCount: 1,
        zoom: 1,
        maxCorrection: 0.1,
        smoothRadius: 24,
        ...overrides,
      };
    }

    it('estimates the FFmpeg encoder when forced', () => {
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        forceFFmpeg: true,
        webGpuAvailable: true,
      });
      expect(plan.encoderIntent).toBe('ffmpeg');
    });

    it('estimates the GPU encoder when WebGPU is available and nothing forces FFmpeg/Canvas', () => {
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        webGpuAvailable: true,
      });
      expect(plan.encoderIntent).toBe('webcodecs');
    });

    it('falls back to FFmpeg when WebGPU has not been confirmed available', () => {
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {});
      expect(plan.encoderIntent).toBe('ffmpeg');
    });

    it('estimates canvas only when the timeline has nothing canvas cannot composite', () => {
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        useCanvasRenderer: true,
      });
      expect(plan.encoderIntent).toBe('canvas');
    });

    it('demotes canvas intent to GPU/FFmpeg when the timeline has active finishing', () => {
      const activeFinishing = {
        ...DEFAULT_FINISHING,
        lut: { enabled: true, lutId: 'some-lut', intensity: 1 },
      };
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        useCanvasRenderer: true,
        finishing: activeFinishing,
        webGpuAvailable: true,
      });
      expect(plan.encoderIntent).not.toBe('canvas');
      expect(plan.finishingActive).toBe(true);
    });

    it('demotes canvas intent to GPU/FFmpeg when a PiP lane is present', () => {
      const clips = [makeClip(), makeClip({ id: 'clip-2', layerIndex: 1 })];
      const plan = calculateRenderPlan(clips, [], [], DEFAULT_EXPORT_SETTINGS, {
        useCanvasRenderer: true,
      });
      expect(plan.encoderIntent).not.toBe('canvas');
    });

    it('reports finishingActive from the finishing context, not from the clips/transitions', () => {
      const inactive = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        finishing: DEFAULT_FINISHING,
      });
      expect(inactive.finishingActive).toBe(false);

      const active = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        finishing: { ...DEFAULT_FINISHING, lut: { enabled: true, lutId: 'x', intensity: 1 } },
      });
      expect(active.finishingActive).toBe(true);
    });

    it('reports stabilizeActive when a clip has an active stabilization matrix', () => {
      const stabilizedClip = makeClip({
        stabilize: true,
        stabilization: makeStabilization(),
      });
      const plan = calculateRenderPlan([stabilizedClip], [], [], DEFAULT_EXPORT_SETTINGS);
      expect(plan.stabilizeActive).toBe(true);
    });

    it('reports stabilizeActive false when no clip has stabilization enabled', () => {
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS);
      expect(plan.stabilizeActive).toBe(false);
    });

    it('estimates overlayKeying as gpu when a clip is keyed and the GPU encoder is expected', () => {
      const keyedClip = makeClip({
        overlayBlend: 'chroma',
        chromaKey: { color: '#00ff00', similarity: 0.4, blend: 0.1 },
      });
      const plan = calculateRenderPlan([keyedClip], [], [], DEFAULT_EXPORT_SETTINGS, {
        webGpuAvailable: true,
      });
      expect(plan.overlayKeying).toBe('gpu');
    });

    it('estimates overlayKeying as ffmpeg when a clip is keyed and FFmpeg is forced', () => {
      const keyedClip = makeClip({
        overlayBlend: 'chroma',
        chromaKey: { color: '#00ff00', similarity: 0.4, blend: 0.1 },
      });
      const plan = calculateRenderPlan([keyedClip], [], [], DEFAULT_EXPORT_SETTINGS, {
        forceFFmpeg: true,
      });
      expect(plan.overlayKeying).toBe('ffmpeg');
    });

    it('never estimates overlayKeying as unsupported when a clip is keyed — canvas is demoted first', () => {
      const keyedClip = makeClip({
        overlayBlend: 'chroma',
        chromaKey: { color: '#00ff00', similarity: 0.4, blend: 0.1 },
      });
      // A keyed clip demotes the canvas estimate to GPU/FFmpeg (see the
      // 'canvas' branch of estimateEncoderIntent), so 'unsupported' should
      // never appear on a pre-render estimate — only after the fact, if the
      // caller ignores the estimate and runs canvas anyway.
      const plan = calculateRenderPlan([keyedClip], [], [], DEFAULT_EXPORT_SETTINGS, {
        useCanvasRenderer: true,
      });
      expect(plan.overlayKeying).toBe('ffmpeg');
    });

    it('omits overlayKeying when no clip is keyed', () => {
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        webGpuAvailable: true,
      });
      expect(plan.overlayKeying).toBeUndefined();
    });

    it('passes captionMode through from context', () => {
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        captionMode: 'burn',
      });
      expect(plan.captionMode).toBe('burn');
    });

    it('flags shaderTextFallbackRisk when shader text is present and FFmpeg is the estimated encoder', () => {
      const shaderOverlay = makeOverlay({ id: 'shader-1', fill: 'shader', shaderId: 'plasma' });
      const plan = calculateRenderPlan([makeClip()], [], [shaderOverlay], DEFAULT_EXPORT_SETTINGS, {
        forceFFmpeg: true,
      });
      expect(plan.shaderTextFallbackRisk).toBe(true);
    });

    it('does not flag shaderTextFallbackRisk when the GPU encoder is estimated (preserves shader fills)', () => {
      const shaderOverlay = makeOverlay({ id: 'shader-1', fill: 'shader', shaderId: 'plasma' });
      const plan = calculateRenderPlan([makeClip()], [], [shaderOverlay], DEFAULT_EXPORT_SETTINGS, {
        webGpuAvailable: true,
      });
      expect(plan.shaderTextFallbackRisk).toBeUndefined();
    });

    it('lists creative LUT and secondary window grades as FFmpeg-only gaps when FFmpeg is estimated', () => {
      const finishing = {
        ...DEFAULT_FINISHING,
        lut: { enabled: true, lutId: 'some-lut', intensity: 1 },
        secondaryColor: {
          ...DEFAULT_FINISHING.secondaryColor!,
          grades: [
            createSecondaryGrade({ enabled: true, maskType: 'window', satScale: 1.5 }),
          ],
        },
      };
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        forceFFmpeg: true,
        finishing,
      });
      expect(plan.ffmpegFinishingGaps).toContain('Creative LUT');
    });

    it('omits ffmpegFinishingGaps when the GPU encoder is estimated (nothing is skipped)', () => {
      const finishing = {
        ...DEFAULT_FINISHING,
        lut: { enabled: true, lutId: 'some-lut', intensity: 1 },
      };
      const plan = calculateRenderPlan([makeClip()], [], [], DEFAULT_EXPORT_SETTINGS, {
        webGpuAvailable: true,
        finishing,
      });
      expect(plan.ffmpegFinishingGaps).toBeUndefined();
    });
  });
});
