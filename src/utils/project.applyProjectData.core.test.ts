import { describe, it, expect } from "vitest";
import type { Clip, Project, TextOverlay } from "../types";
import { applyProjectData } from "./project";
import { createTestClip } from "./project.test.helpers";

describe("utils/project - applyProjectData (core)", () => {
  it("should restore clips when files are available by name", async () => {
    const sourceClips = [createTestClip("source1", 10, "Source Clip 1")];

    const project: Project = {
      clips: [
        {
          id: "saved1",
          title: "Saved Clip",
          kind: "video",
          duration: 10,
          trimStart: 1,
          trimEnd: 8,
          videoFadeIn: 0.2,
          videoFadeOut: 0.1,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source1.mp4",
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips).toHaveLength(1);
    expect(result.clips[0].title).toBe("Saved Clip");
    expect(result.clips[0].trimStart).toBe(1);
    expect(result.clips[0].trimEnd).toBe(8);
  });

  it("should restore A/B groups from saved project", async () => {
    const clipA = createTestClip("a", 5, "Clip A", "group1", "A");
    const clipB = createTestClip("b", 5, "Clip B", "group1", "B");
    const sourceClips = [clipA, clipB];

    const project: Project = {
      clips: [
        {
          id: "a",
          title: "Clip A",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "a.mp4",
          groupId: "group1",
          groupVariant: "A",
        },
        {
          id: "b",
          title: "Clip B",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "b.mp4",
          groupId: "group1",
          groupVariant: "B",
        },
      ],
      clipGroups: [
        {
          id: "group1",
          activeVariant: "B",
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clipGroups).toHaveLength(1);
    expect(result.clipGroups[0].id).toBe("group1");
    expect(result.clipGroups[0].activeVariant).toBe("B");
    expect(result.clipGroups[0].variants.A).not.toBeNull();
    expect(result.clipGroups[0].variants.B).not.toBeNull();
  });

  it("should skip clips that cannot be restored", async () => {
    const sourceClips: Clip[] = []; // No source clips

    const project: Project = {
      clips: [
        {
          id: "missing",
          title: "Missing Clip",
          kind: "video",
          duration: 10,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "missing.mp4",
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips).toHaveLength(0);
    expect(result.skippedClipCount).toBe(1);
    expect(result.skippedClipFileNames).toContain("missing.mp4");
  });

  it("should restore transitions from project", async () => {
    const sourceClips = [createTestClip("a", 5), createTestClip("b", 3)];

    const project: Project = {
      clips: [
        {
          id: "a",
          title: "Clip A",
          kind: "video",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "a.mp4",
        },
        {
          id: "b",
          title: "Clip B",
          kind: "video",
          duration: 3,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "b.mp4",
        },
      ],
      transitions: [
        {
          afterClipIndex: 1,
          type: "dissolve",
          duration: 0.5,
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0].afterClipIndex).toBe(1);
    expect(result.transitions[0].type).toBe("dissolve");
    expect(result.transitions[0].duration).toBe(0.5);
  });

  it("should sanitize invalid text overlay colors and report a warning", async () => {
    const sourceClips = [createTestClip("a", 5)];

    const project: Project = {
      clips: [],
      textOverlays: [
        {
          id: "ov1",
          text: "Hello",
          fontsize: 40,
          fontcolor: "notacolor",
          x: 50,
          y: 650,
          scrolling: false,
          scrollSpeed: 100,
          box: true,
          boxColor: "also-bad",
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.textOverlays[0].fontcolor).toBe("#ffffff");
    expect(result.textOverlays[0].boxColor).toBe("black@0.5");
    expect(result.invalidColorWarnings).toHaveLength(2);
    expect(result.invalidColorWarnings[0]).toContain("notacolor");
    expect(result.invalidColorWarnings[1]).toContain("also-bad");
  });

  it("should leave valid text overlay colors untouched", async () => {
    const sourceClips = [createTestClip("a", 5)];

    const project: Project = {
      clips: [],
      textOverlays: [
        {
          id: "ov1",
          text: "Hello",
          fontsize: 40,
          fontcolor: "yellow",
          x: 50,
          y: 650,
          scrolling: false,
          scrollSpeed: 100,
          box: false,
          boxColor: "black@0.5",
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.textOverlays[0].fontcolor).toBe("yellow");
    expect(result.textOverlays[0].boxColor).toBe("black@0.5");
    expect(result.invalidColorWarnings).toHaveLength(0);
  });

  it("should default text overlay font to roboto when field is absent (backward compat)", async () => {
    const sourceClips = [createTestClip("a", 5)];
    const project: Project = {
      clips: [],
      textOverlays: [
        {
          id: "ov1",
          text: "Legacy",
          fontsize: 32,
          fontcolor: "white",
          x: 10,
          y: 10,
          scrolling: false,
          scrollSpeed: 20,
          box: false,
          boxColor: "black@0.5",
          // no 'font' field on purpose
        } as TextOverlay,
      ],
    };
    const result = await applyProjectData(project, sourceClips);
    // When default, we omit the field on restore to keep shape minimal
    expect(result.textOverlays[0].font).toBeUndefined();
  });

  it("should preserve a valid explicit font id through apply", async () => {
    const sourceClips = [createTestClip("a", 5)];
    const project: Project = {
      clips: [],
      textOverlays: [
        {
          id: "ov1",
          text: "Bold",
          fontsize: 32,
          fontcolor: "white",
          x: 10,
          y: 10,
          scrolling: false,
          scrollSpeed: 20,
          box: false,
          boxColor: "black@0.5",
          font: "robotoBold",
        },
      ],
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.textOverlays[0].font).toBe("robotoBold");
  });

  it("should fall back to default for unknown font id without crashing", async () => {
    const sourceClips = [createTestClip("a", 5)];
    const project: Project = {
      clips: [],
      textOverlays: [
        {
          id: "ov1",
          text: "Weird",
          fontsize: 32,
          fontcolor: "white",
          x: 10,
          y: 10,
          scrolling: false,
          scrollSpeed: 20,
          box: false,
          boxColor: "black@0.5",
          font: "nonexistent-font",
        },
      ],
    };
    const result = await applyProjectData(project, sourceClips);
    // Falls back; we don't persist default in the restored object
    expect(result.textOverlays[0].font).toBeUndefined();
  });

  it("should preserve shader fill fields and warn on unknown shaderId", async () => {
    const sourceClips = [createTestClip("a", 5)];
    const project: Project = {
      clips: [],
      textOverlays: [
        {
          id: "ov1",
          text: "FX",
          fontsize: 30,
          fontcolor: "white",
          x: 5,
          y: 5,
          scrolling: false,
          scrollSpeed: 20,
          box: true,
          boxColor: "black@0.3",
          fill: "shader",
          shaderId: "gradient",
          shaderParams: { speed: 2.5 },
        } as any,
        {
          id: "ov2",
          text: "BadFX",
          fontsize: 20,
          fontcolor: "white",
          x: 0,
          y: 0,
          scrolling: false,
          scrollSpeed: 20,
          box: false,
          boxColor: "black@0.5",
          fill: "shader",
          shaderId: "nope-shader",
        } as any,
      ],
    };
    const result = await applyProjectData(project, sourceClips);
    expect(result.textOverlays[0].fill).toBe("shader");
    expect(result.textOverlays[0].shaderId).toBe("gradient");
    expect(result.textOverlays[0].shaderParams?.speed).toBeCloseTo(2.5);
    // Unknown shader falls back and emits a warning
    expect(result.textOverlays[1].fill).toBe("shader");
    expect(result.textOverlays[1].shaderId).toBeUndefined();
    expect(result.invalidColorWarnings.some((w) => /unknown shader/i.test(w))).toBe(true);
  });

  it("should throw error if project is invalid", async () => {
    const sourceClips = [createTestClip("a", 5)];
    const invalidProject = { clips: null } as unknown as Project;
    await expect(
      applyProjectData(invalidProject, sourceClips),
    ).rejects.toThrow("Project file is invalid");
  });

  it("should apply clip adjustments (trim, fade) when restoring", async () => {
    const sourceClips = [createTestClip("source", 10)];

    const project: Project = {
      clips: [
        {
          id: "saved",
          title: "Saved",
          kind: "video",
          duration: 10,
          trimStart: 2,
          trimEnd: 8,
          videoFadeIn: 0.3,
          videoFadeOut: 0.2,
          audioFadeIn: 0.1,
          audioFadeOut: 0.15,
          fileName: "source.mp4",
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].trimStart).toBe(2);
    expect(result.clips[0].trimEnd).toBe(8);
    expect(result.clips[0].videoFadeIn).toBe(0.3);
    expect(result.clips[0].videoFadeOut).toBe(0.2);
    expect(result.clips[0].audioFadeIn).toBe(0.1);
    expect(result.clips[0].audioFadeOut).toBe(0.15);
  });

  it("should apply PiP properties when restoring normalized layout", async () => {
    const sourceClips = [createTestClip("source", 10)];

    const project: Project = {
      schemaVersion: 2,
      clips: [
        {
          id: "saved",
          title: "Saved",
          kind: "video",
          duration: 10,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source.mp4",
          layerIndex: 1,
          x: 100 / 1280,
          y: 150 / 720,
          width: 300 / 1280,
          height: 200 / 720,
          opacity: 0.7,
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].layerIndex).toBe(1);
    expect(result.clips[0].x).toBeCloseTo(100 / 1280);
    expect(result.clips[0].y).toBeCloseTo(150 / 720);
    expect(result.clips[0].width).toBeCloseTo(300 / 1280);
    expect(result.clips[0].height).toBeCloseTo(200 / 720);
    expect(result.clips[0].opacity).toBe(0.7);
  });

  it("should migrate legacy pixel PiP coordinates on load", async () => {
    const sourceClips = [createTestClip("source", 10)];

    const project: Project = {
      schemaVersion: 1,
      layoutReferenceResolution: "1280x720",
      clips: [
        {
          id: "saved",
          title: "Saved",
          kind: "video",
          duration: 10,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: "source.mp4",
          layerIndex: 1,
          x: 100,
          y: 150,
          width: 300,
          height: 200,
        },
      ],
      textOverlays: [
        {
          id: "text1",
          text: "Hello",
          fontsize: 40,
          fontcolor: "#ffffff",
          x: 50,
          y: 650,
          scrolling: false,
          scrollSpeed: 20,
          box: false,
          boxColor: "black@0.5",
        },
      ],
    };

    const result = await applyProjectData(project, sourceClips);
    expect(result.clips[0].x).toBeCloseTo(100 / 1280);
    expect(result.clips[0].y).toBeCloseTo(150 / 720);
    expect(result.textOverlays[0].x).toBeCloseTo(50 / 1280);
    expect(result.textOverlays[0].y).toBeCloseTo(650 / 720);
  });
});
