import { describe, it, expect } from "vitest";
import type { ClipGroup, ClipTransition } from "../types";
import { serializeProject, applyProjectData } from "./project";
import { createTestClip } from "./project.test.helpers";

describe("utils/project - Serialize/Apply Roundtrip", () => {
  it("should roundtrip simple project: serialize then apply", async () => {
    // Create original project
    const originalClips = [
      createTestClip("a", 5, "Clip A"),
      createTestClip("b", 3, "Clip B"),
    ];
    const originalTransitions: ClipTransition[] = [
      { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
    ];

    // Serialize
    const serialized = serializeProject(
      originalClips,
      originalTransitions,
      [],
      [],
    );

    // Apply (simulate loading)
    const result = await applyProjectData(serialized, originalClips);

    // Verify roundtrip
    expect(result.clips).toHaveLength(2);
    expect(result.clips[0].title).toBe("Clip A");
    expect(result.clips[1].title).toBe("Clip B");
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0].type).toBe("dissolve");
  });

  it("should roundtrip a custom WGSL transition and its params", async () => {
    const clips = [createTestClip("a", 5, "Clip A"), createTestClip("b", 3, "Clip B")];
    const expression = "mix(sampleTo(uv), sampleFrom(uv), u.progress * u.custom0)";
    const transitions: ClipTransition[] = [
      {
        afterClipIndex: 1,
        type: "custom",
        duration: 0.4,
        params: { amount: 0.5 },
        customShader: expression,
      },
    ];

    const serialized = serializeProject(clips, transitions, [], []);
    expect(serialized.transitions?.[0].customShader).toBe(expression);

    const result = await applyProjectData(serialized, clips);
    expect(result.transitions[0].type).toBe("custom");
    expect(result.transitions[0].customShader).toBe(expression);
    expect(result.transitions[0].params).toEqual({ amount: 0.5 });
  });

  it("should roundtrip the stabilize toggle without its matrices", async () => {
    const clips = [
      { ...createTestClip("a", 5, "Clip A"), stabilize: true },
      createTestClip("b", 3, "Clip B"),
    ];
    const serialized = serializeProject(clips, [], [], []);
    expect(serialized.clips[0].stabilize).toBe(true);
    expect(serialized.clips[1]).not.toHaveProperty("stabilize");
    // Matrices are derived data — keeping them out is what stops a project
    // file growing tens of KB per stabilized clip.
    expect(JSON.stringify(serialized)).not.toContain("matrices");

    const result = await applyProjectData(serialized, clips);
    expect(result.clips[0].stabilize).toBe(true);
    expect(result.clips[0].stabilization).toBeUndefined();
    expect(result.clips[1].stabilize).toBeUndefined();
  });

  it("should load pre-custom-shader projects without a shader field", async () => {
    const clips = [createTestClip("a", 5, "Clip A"), createTestClip("b", 3, "Clip B")];
    const serialized = serializeProject(
      clips,
      [{ afterClipIndex: 1, type: "filmBurn", duration: 0.5 }],
      [],
      [],
    );
    expect(serialized.transitions?.[0]).not.toHaveProperty("customShader");

    const result = await applyProjectData(serialized, clips);
    expect(result.transitions[0].type).toBe("filmBurn");
    expect(result.transitions[0].customShader).toBeUndefined();
  });

  it("should roundtrip complex project with A/B groups", async () => {
    // Create original project with A/B groups
    const clipA = createTestClip("a", 5, "Version A", "group1", "A");
    const clipB = createTestClip("b", 5, "Version B", "group1", "B");
    const clipGroups: ClipGroup[] = [
      {
        id: "group1",
        variants: { A: clipA, B: clipB },
        activeVariant: "B",
      },
    ];

    // Serialize
    const serialized = serializeProject([clipA, clipB], [], [], clipGroups);

    // Apply
    const result = await applyProjectData(serialized, [clipA, clipB]);

    // Verify roundtrip
    expect(result.clipGroups).toHaveLength(1);
    expect(result.clipGroups[0].activeVariant).toBe("B");
  });

  it("should roundtrip overlay keying settings", async () => {
    const logo = createTestClip("logo", 5, "Channel bug");
    logo.layerIndex = 1;
    logo.overlayBlend = "chroma";
    logo.chromaKey = { color: "#00FF00", similarity: 0.25, blend: 0.05 };

    const serialized = serializeProject([logo], [], [], []);
    expect(serialized.clips[0].overlayBlend).toBe("chroma");
    expect(serialized.clips[0].chromaKey).toEqual({
      color: "#00FF00",
      similarity: 0.25,
      blend: 0.05,
    });

    const result = await applyProjectData(serialized, [logo]);
    expect(result.clips[0].overlayBlend).toBe("chroma");
    expect(result.clips[0].chromaKey).toEqual({
      color: "#00FF00",
      similarity: 0.25,
      blend: 0.05,
    });
  });

  it("should omit overlay keying for clips that do not use it", () => {
    const serialized = serializeProject([createTestClip("a", 5)], [], [], []);
    expect(serialized.clips[0].overlayBlend).toBeUndefined();
    expect(serialized.clips[0].chromaKey).toBeUndefined();
  });
});
