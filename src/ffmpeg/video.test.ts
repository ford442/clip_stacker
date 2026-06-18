import { describe, it, expect } from "vitest";
import type { Clip, ClipTransition, TextOverlay } from "../types";
import { buildPipFilterComplex } from "./video";
import { appendTextOverlayFilters } from "./core";

function createTestOverlay(id: string, overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id,
    text: "Hello",
    fontsize: 24,
    fontcolor: "white",
    x: 10,
    y: 10,
    scrolling: false,
    scrollSpeed: 0,
    box: false,
    boxColor: "black@0.5",
    ...overrides,
  };
}

// Helper to create a minimal test clip
function createTestClip(
  id: string,
  duration: number,
  overrides: Partial<Clip> = {},
): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: "video",
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe("buildPipFilterComplex", () => {
  it("concatenates base clips with a hard cut when no transitions are given", () => {
    const clips = [
      createTestClip("a", 5),
      createTestClip("b", 3),
      createTestClip("pip", 4, { layerIndex: 1, x: 10, y: 20 }),
    ];

    const filterComplex = buildPipFilterComplex(clips);

    expect(filterComplex).toContain("concat=n=2:v=1:a=0[vbase]");
    expect(filterComplex).toContain("concat=n=2:v=0:a=1[abase]");
    expect(filterComplex).toContain("overlay=10:20:eof_action=pass[vout]");
    expect(filterComplex).not.toContain("xfade");
  });

  it("applies a crossfade transition between base clips while still compositing PiP overlay", () => {
    const clips = [
      createTestClip("a", 5),
      createTestClip("b", 3),
      createTestClip("pip", 4, { layerIndex: 1, x: 10, y: 20 }),
    ];
    const transitions: ClipTransition[] = [
      { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
    ];

    const filterComplex = buildPipFilterComplex(clips, transitions);

    // Base layer transition is preserved
    expect(filterComplex).toContain("xfade=transition=fade");
    expect(filterComplex).toContain("acrossfade=d=0.5");
    expect(filterComplex).toContain("[vbase]");
    expect(filterComplex).toContain("[abase]");

    // PiP overlay is still composited on top of the transitioned base
    expect(filterComplex).toContain("overlay=10:20:eof_action=pass[vout]");
  });

  it("ignores a transition that is not between adjacent base clips", () => {
    const clips = [
      createTestClip("a", 5),
      createTestClip("b", 3),
      createTestClip("pip", 4, { layerIndex: 1, x: 0, y: 0 }),
    ];
    // afterClipIndex 2 refers to the PiP clip, not a base-layer neighbour of "b"
    const transitions: ClipTransition[] = [
      { afterClipIndex: 2, type: "dissolve", duration: 0.5 },
    ];

    const filterComplex = buildPipFilterComplex(clips, transitions);

    expect(filterComplex).not.toContain("xfade");
    expect(filterComplex).toContain("concat=n=2:v=1:a=0[vbase]");
  });

  it("throws if there is no base-layer clip", () => {
    const clips = [createTestClip("pip", 4, { layerIndex: 1 })];
    expect(() => buildPipFilterComplex(clips)).toThrow(
      /requires at least one base-layer clip/,
    );
  });

  it("mutes overlay audio when volume is 0", () => {
    const clips = [
      createTestClip("a", 5),
      createTestClip("pip", 4, { layerIndex: 1, x: 10, y: 20, volume: 0 }),
    ];

    const filterComplex = buildPipFilterComplex(clips);

    expect(filterComplex).toContain("volume=0.0000");
    const finalAudioLine = filterComplex
      .split(";")
      .find((part) => part.endsWith("[aout]"));
    expect(finalAudioLine).not.toContain("[a1]");
  });

  it("applies a volume filter to overlay audio when volume differs from 1", () => {
    const clips = [
      createTestClip("a", 5),
      createTestClip("pip", 4, { layerIndex: 1, x: 10, y: 20, volume: 0.5 }),
    ];

    const filterComplex = buildPipFilterComplex(clips);

    expect(filterComplex).toContain("volume=0.5000");
    expect(filterComplex).toContain("amix=inputs=2:normalize=0[aout]");
    expect(filterComplex).toContain("[a1]");
  });

  it("applies volume to base-layer clip audio during per-clip preprocessing", () => {
    const clips = [createTestClip("a", 5, { volume: 1.5 })];

    const filterComplex = buildPipFilterComplex(clips);

    expect(filterComplex).toContain("volume=1.5000");
  });
});

describe("appendTextOverlayFilters", () => {
  it("returns the filter_complex unchanged when there are no text overlays", () => {
    const filterComplex = "[0:v]null[vout];[0:a]anull[aout]";
    expect(appendTextOverlayFilters(filterComplex, [])).toBe(filterComplex);
  });

  it("renames the final [vout] sink and chains drawtext filters back onto [vout]", () => {
    const filterComplex = "[0:v]null[vout];[0:a]anull[aout]";
    const overlays = [createTestOverlay("a"), createTestOverlay("b")];

    const result = appendTextOverlayFilters(filterComplex, overlays);

    expect(result).toBe(
      "[0:v]null[vpretext];[0:a]anull[aout];[vpretext]drawtext=fontfile=roboto.ttf:text='Hello':x=10:y=10:fontsize=24:fontcolor=white,drawtext=fontfile=roboto.ttf:text='Hello':x=10:y=10:fontsize=24:fontcolor=white[vout]",
    );
  });

  it("builds a resolution-independent x expression for scrolling overlays", () => {
    const filterComplex = "[0:v]null[vout];[0:a]anull[aout]";
    const overlay = createTestOverlay("a", { scrolling: true, scrollSpeed: 20 });

    const result = appendTextOverlayFilters(filterComplex, [overlay]);

    expect(result).toContain("x=w+tw-(t*w*0.2000)");
  });
});
