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
});
