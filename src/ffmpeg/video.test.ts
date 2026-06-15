import { describe, it, expect } from "vitest";
import type { Clip, ClipTransition } from "../types";
import { buildPipFilterComplex } from "./video";

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
});
