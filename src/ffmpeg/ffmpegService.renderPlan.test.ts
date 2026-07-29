import { describe, it, expect } from "vitest";
import type { Clip, TextOverlay } from "../types";
import { DEFAULT_EXPORT_SETTINGS } from "../types";
import { calculateRenderPlan } from "./ffmpegService";

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
});
