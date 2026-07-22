import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  Clip,
  ClipGroup,
  ClipTransition,
  Project,
  TextOverlay,
} from "../types";
import {
  getClipDuration,
  sanitizeClipAdjustments,
  serializeProject,
  serializeProjectWithMedia,
  applyProjectData,
  MAX_UPLOAD_RETRY_ATTEMPTS,
  MAX_EMBED_FILE_BYTES,
  CHUNK_THRESHOLD_BYTES,
  ContaboStorageManagerClient,
} from "./project";
import * as storageUpload from "./storageUpload";

// Helper to create a minimal test clip
function createTestClip(
  id: string,
  duration: number,
  title = id,
  groupId?: string,
  groupVariant?: "A" | "B",
): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title,
    kind: "video",
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    groupId,
    groupVariant,
  };
}

describe("utils/project", () => {
  // =========================================================================
  // getClipDuration
  // =========================================================================
  describe("getClipDuration", () => {
    it("should return duration - trimStart when trimEnd is not set", () => {
      const clip = createTestClip("test", 10);
      clip.trimStart = 2;
      const duration = getClipDuration(clip);
      expect(duration).toBe(8); // 10 - 2
    });

    it("should return trimEnd - trimStart when both are set", () => {
      const clip = createTestClip("test", 10);
      clip.trimStart = 1;
      clip.trimEnd = 6;
      const duration = getClipDuration(clip);
      expect(duration).toBe(5); // 6 - 1
    });

    it("should enforce MIN_CLIP_DURATION", () => {
      const clip = createTestClip("test", 10);
      clip.trimStart = 5;
      clip.trimEnd = 5.05; // Very short
      const duration = getClipDuration(clip);
      expect(duration).toBe(0.1); // MIN_CLIP_DURATION
    });
  });

  // =========================================================================
  // sanitizeClipAdjustments
  // =========================================================================
  describe("sanitizeClipAdjustments", () => {
    it("should clamp trimStart to 0", () => {
      const clip = createTestClip("test", 10);
      clip.trimStart = -5;
      sanitizeClipAdjustments(clip);
      expect(clip.trimStart).toBe(0);
    });

    it("should ensure trimEnd >= trimStart + MIN_CLIP_DURATION", () => {
      const clip = createTestClip("test", 10);
      clip.trimStart = 5;
      clip.trimEnd = 5; // Violates minimum
      sanitizeClipAdjustments(clip);
      expect(clip.trimEnd).toBe(5.1); // trimStart + MIN_CLIP_DURATION
    });

    it("should clamp fades to valid range", () => {
      const clip = createTestClip("test", 1);
      clip.videoFadeIn = 10; // Too large
      clip.videoFadeOut = -5; // Negative
      sanitizeClipAdjustments(clip);
      expect(clip.videoFadeIn).toBeLessThanOrEqual(0.49); // Safe margin
      expect(clip.videoFadeOut).toBe(0);
    });

    it("should clamp volume to 0–2", () => {
      const clip = createTestClip("test", 5);
      clip.volume = 3;
      sanitizeClipAdjustments(clip);
      expect(clip.volume).toBe(2);

      clip.volume = -0.5;
      sanitizeClipAdjustments(clip);
      expect(clip.volume).toBe(0);
    });
  });

  // =========================================================================
  // serializeProject
  // =========================================================================
  describe("serializeProject", () => {
    it("should serialize clips without optional fields", () => {
      const clips = [createTestClip("clip1", 5)];
      const project = serializeProject(clips, [], [], []);
      expect(project.clips).toHaveLength(1);
      expect(project.clips[0]).toEqual({
        id: "clip1",
        title: "clip1",
        kind: "video",
        duration: 5,
        trimStart: 0,
        trimEnd: null,
        videoFadeIn: 0,
        videoFadeOut: 0,
        audioFadeIn: 0,
        audioFadeOut: 0,
        fileName: "clip1.mp4",
      });
    });

    it("should serialize clips with group info", () => {
      const clips = [createTestClip("clip1", 5, "clip1", "group1", "A")];
      const project = serializeProject(clips, [], [], []);
      expect(project.clips[0].groupId).toBe("group1");
      expect(project.clips[0].groupVariant).toBe("A");
    });

    it("should serialize non-default clip volume", () => {
      const clips = [createTestClip("clip1", 5)];
      clips[0].volume = 0.75;
      const project = serializeProject(clips, [], [], []);
      expect(project.clips[0].volume).toBe(0.75);
    });

    it("should serialize transitions", () => {
      const clips = [createTestClip("a", 5), createTestClip("b", 3)];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
      ];
      const project = serializeProject(clips, transitions, [], []);
      expect(project.transitions).toHaveLength(1);
      expect(project.transitions![0]).toEqual({
        afterClipIndex: 1,
        type: "dissolve",
        duration: 0.5,
      });
    });

    it("should serialize text overlays", () => {
      const clips = [createTestClip("clip1", 5)];
      const textOverlays: TextOverlay[] = [
        {
          id: "text1",
          text: "Hello",
          fontsize: 40,
          fontcolor: "#ffffff",
          x: 50,
          y: 650,
          scrolling: false,
          scrollSpeed: 100,
          box: false,
          boxColor: "black@0.5",
        },
      ];
      const project = serializeProject(clips, [], textOverlays, []);
      expect(project.textOverlays).toBeDefined();
      expect(project.textOverlays).toHaveLength(1);
    });

    it("should round-trip an explicit font id through serialize", () => {
      const clips = [createTestClip("clip1", 5)];
      const textOverlays: TextOverlay[] = [
        {
          id: "text1",
          text: "Ticker",
          fontsize: 28,
          fontcolor: "white",
          x: 0,
          y: 0,
          scrolling: true,
          scrollSpeed: 30,
          box: false,
          boxColor: "black@0.5",
          font: "mono",
        },
      ];
      const project = serializeProject(clips, [], textOverlays, []);
      expect(project.textOverlays?.[0]?.font).toBe("mono");
    });

    it("should serialize clip groups", () => {
      const clips = [createTestClip("a", 5)];
      const clipGroups: ClipGroup[] = [
        {
          id: "group1",
          variants: { A: clips[0], B: null },
          activeVariant: "A",
        },
      ];
      const project = serializeProject(clips, [], [], clipGroups);
      expect(project.clipGroups).toBeDefined();
      expect(project.clipGroups).toHaveLength(1);
      expect(project.clipGroups![0].id).toBe("group1");
      expect(project.clipGroups![0].activeVariant).toBe("A");
    });

    it("should serialize PiP properties", () => {
      const clip = createTestClip("clip1", 5);
      clip.layerIndex = 1;
      clip.x = 100;
      clip.y = 200;
      clip.width = 300;
      clip.height = 400;
      clip.opacity = 0.8;
      const project = serializeProject([clip], [], [], []);
      expect(project.clips[0].layerIndex).toBe(1);
      expect(project.clips[0].x).toBe(100);
      expect(project.clips[0].y).toBe(200);
      expect(project.clips[0].width).toBe(300);
      expect(project.clips[0].height).toBe(400);
      expect(project.clips[0].opacity).toBe(0.8);
    });

    it('should serialize keyframes and stillImage flag', () => {
      const clip = createTestClip('clip1', 5);
      clip.stillImage = true;
      clip.keyframes = {
        uvScaleX: [
          { t: 0, value: 1, easing: { type: 'linear' } },
          { t: 5, value: 0.86 },
        ],
        opacity: [{ t: 0, value: 1 }],
      };
      const project = serializeProject([clip], [], [], []);
      expect(project.clips[0].stillImage).toBe(true);
      expect(project.clips[0].keyframes?.uvScaleX).toHaveLength(2);
      expect(project.clips[0].keyframes?.opacity).toHaveLength(1);
    });

    it('should serialize color grade settings', () => {
      const project = serializeProject([], [], [], [], {
        lutId: 'film',
        intensity: 0.75,
      });
      expect(project.colorGrade?.lutId).toBe('film');
      expect(project.colorGrade?.intensity).toBe(0.75);
    });
  });

  // =========================================================================
  // applyProjectData
  // =========================================================================
  describe("applyProjectData", () => {
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

    it("should apply PiP properties when restoring", async () => {
      const sourceClips = [createTestClip("source", 10)];

      const project: Project = {
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
            opacity: 0.7,
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.clips[0].layerIndex).toBe(1);
      expect(result.clips[0].x).toBe(100);
      expect(result.clips[0].y).toBe(150);
      expect(result.clips[0].width).toBe(300);
      expect(result.clips[0].height).toBe(200);
      expect(result.clips[0].opacity).toBe(0.7);
    });

    it('should restore keyframes and stillImage from saved project', async () => {
      const sourceClips = [createTestClip('source1', 5, 'photo.jpg')];
      sourceClips[0].file = new File([], 'photo.jpg', { type: 'image/jpeg' });

      const project: Project = {
        clips: [
          {
            id: 'saved',
            title: 'Photo',
            kind: 'video',
            duration: 5,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'photo.jpg',
            stillImage: true,
            keyframes: {
              x: [{ t: 0, value: 10 }, { t: 2, value: 50 }],
            },
          },
        ],
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.clips[0].stillImage).toBe(true);
      expect(result.clips[0].keyframes?.x).toHaveLength(2);
    });

    it('should restore color grade from saved project', async () => {
      const sourceClips = [createTestClip('source1', 5)];
      const project: Project = {
        clips: [
          {
            id: 'saved',
            title: 'Clip',
            kind: 'video',
            duration: 5,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: 'source1.mp4',
          },
        ],
        colorGrade: {
          lutId: 'teal-orange',
          intensity: 0.6,
        },
      };

      const result = await applyProjectData(project, sourceClips);
      expect(result.colorGrade.lutId).toBe('teal-orange');
      expect(result.colorGrade.intensity).toBe(0.6);
    });
  });

  // =========================================================================
  // Integration: Serialize/Apply Roundtrip
  // =========================================================================
  describe("Serialize/Apply Roundtrip", () => {
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

  // =========================================================================
  // serializeProjectWithMedia — remote upload retry cap
  // =========================================================================
  describe("serializeProjectWithMedia remote upload retries", () => {
    it("aborts after MAX_UPLOAD_RETRY_ATTEMPTS instead of retrying forever", async () => {
      const clip = createTestClip("clip1", 5);
      const mediaClient = {
        uploadMedia: vi.fn().mockRejectedValue(new Error("upload failed")),
      } as unknown as ContaboStorageManagerClient;

      await expect(
        serializeProjectWithMedia([clip], [], [], [], {
          mediaMode: "remote",
          mediaClient,
          onRemoteUploadError: () => "retry",
        }),
      ).rejects.toThrow(/after \d+ attempts/);

      expect(mediaClient.uploadMedia).toHaveBeenCalledTimes(
        MAX_UPLOAD_RETRY_ATTEMPTS,
      );
    });

    it("succeeds once the upload eventually resolves within the retry cap", async () => {
      const clip = createTestClip("clip1", 5);
      let calls = 0;
      const mediaClient = {
        uploadMedia: vi.fn().mockImplementation(() => {
          calls += 1;
          if (calls < 2) return Promise.reject(new Error("transient"));
          return Promise.resolve("https://example.com/clip1.mp4");
        }),
      } as unknown as ContaboStorageManagerClient;

      const project = await serializeProjectWithMedia([clip], [], [], [], {
        mediaMode: "remote",
        mediaClient,
        onRemoteUploadError: () => "retry",
      });

      expect(project.clips[0].sourceMediaUrl).toBe(
        "https://example.com/clip1.mp4",
      );
      expect(mediaClient.uploadMedia).toHaveBeenCalledTimes(2);
    });

    it("reuses an existing remoteSourceUrl instead of re-uploading", async () => {
      const clip = createTestClip("clip1", 5);
      clip.remoteSourceUrl = "https://example.com/library/clip1.mp4";
      const mediaClient = {
        uploadMedia: vi.fn().mockResolvedValue("https://example.com/clip1.mp4"),
      } as unknown as ContaboStorageManagerClient;

      const project = await serializeProjectWithMedia([clip], [], [], [], {
        mediaMode: "remote",
        mediaClient,
      });

      expect(project.clips[0].sourceMediaUrl).toBe(
        "https://example.com/library/clip1.mp4",
      );
      expect(mediaClient.uploadMedia).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // serializeProjectWithMedia — large file embed handling
  // =========================================================================
  describe("serializeProjectWithMedia large-file embed handling", () => {
    function createLargeClip(id: string): Clip {
      const clip = createTestClip(id, 5);
      Object.defineProperty(clip.file, "size", {
        value: MAX_EMBED_FILE_BYTES + 1,
        configurable: true,
      });
      return clip;
    }

    it("embeds small files without warning", async () => {
      const clip = createTestClip("clip1", 5);
      const onEmbedWarning = vi.fn();

      const project = await serializeProjectWithMedia([clip], [], [], [], {
        mediaMode: "embed",
        onEmbedWarning,
      });

      expect(project.clips[0].sourceMediaDataUrl).toBeDefined();
      expect(project.clips[0].sourceMediaUrl).toBeUndefined();
      expect(onEmbedWarning).not.toHaveBeenCalled();
    });

    it("warns and still embeds an oversized file when no media client is provided", async () => {
      const clip = createLargeClip("clip1");
      const onEmbedWarning = vi.fn();

      const project = await serializeProjectWithMedia([clip], [], [], [], {
        mediaMode: "embed",
        onEmbedWarning,
      });

      expect(project.clips[0].sourceMediaDataUrl).toBeDefined();
      expect(onEmbedWarning).toHaveBeenCalledTimes(1);
      expect(onEmbedWarning.mock.calls[0][0]).toContain("clip1.mp4");
    });

    it("uploads an oversized file to remote storage instead of embedding when a media client is provided", async () => {
      const clip = createLargeClip("clip1");
      const onEmbedWarning = vi.fn();
      const mediaClient = {
        uploadMedia: vi.fn().mockResolvedValue("https://example.com/clip1.mp4"),
      } as unknown as ContaboStorageManagerClient;

      const project = await serializeProjectWithMedia([clip], [], [], [], {
        mediaMode: "embed",
        mediaClient,
        onEmbedWarning,
      });

      expect(project.clips[0].sourceMediaDataUrl).toBeUndefined();
      expect(project.clips[0].sourceMediaUrl).toBe("https://example.com/clip1.mp4");
      expect(onEmbedWarning).toHaveBeenCalledTimes(1);
      expect(onEmbedWarning.mock.calls[0][0]).toContain("uploaded to remote storage");
    });
  });

  // =========================================================================
  // mediaMode persistence and authoritative source selection
  // =========================================================================
  describe("mediaMode-aware media source selection", () => {
    it("records mediaMode on the serialized project and clears the unused field", async () => {
      const clip = createTestClip("clip1", 5);

      const embedded = await serializeProjectWithMedia([clip], [], [], [], {
        mediaMode: "embed",
      });
      expect(embedded.mediaMode).toBe("embed");
      expect(embedded.clips[0].sourceMediaDataUrl).toBeDefined();
      expect(embedded.clips[0].sourceMediaUrl).toBeUndefined();

      const mediaClient = {
        uploadMedia: vi.fn().mockResolvedValue("https://example.com/clip1.mp4"),
      } as unknown as ContaboStorageManagerClient;
      const remote = await serializeProjectWithMedia([clip], [], [], [], {
        mediaMode: "remote",
        mediaClient,
      });
      expect(remote.mediaMode).toBe("remote");
      expect(remote.clips[0].sourceMediaUrl).toBe("https://example.com/clip1.mp4");
      expect(remote.clips[0].sourceMediaDataUrl).toBeUndefined();
    });

  });

  // =========================================================================
  // ContaboStorageManagerClient.listMedia
  // =========================================================================
  describe("ContaboStorageManagerClient.listMedia", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("fetches the media endpoint and returns the file list", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          files: [
            { name: "clip1.mp4", url: "https://example.com/media/clip1.mp4", size: 1024, modified: 1700000000 },
          ],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new ContaboStorageManagerClient("https://example.com/api", "token123");
      const items = await client.listMedia();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/api/media",
        { headers: { authorization: "Bearer token123" } },
      );
      expect(items).toEqual([
        { name: "clip1.mp4", url: "https://example.com/media/clip1.mp4", size: 1024, modified: 1700000000 },
      ]);
    });

    it("returns an empty array when the server omits the files field", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new ContaboStorageManagerClient("https://example.com/api");
      const items = await client.listMedia();

      expect(items).toEqual([]);
    });

    it("throws a descriptive error when the request fails", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal("fetch", fetchMock);

      const client = new ContaboStorageManagerClient("https://example.com/api");

      await expect(client.listMedia()).rejects.toThrow(/500/);
    });
  });

  // =========================================================================
  // ContaboStorageManagerClient.uploadMedia — chunked vs single-request
  // =========================================================================
  describe("ContaboStorageManagerClient.uploadMedia routing", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("uses the single-request path for files at or below the chunk threshold", async () => {
      const chunkedSpy = vi
        .spyOn(storageUpload, "uploadMediaChunked")
        .mockResolvedValue("https://example.com/chunked.mp4");

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "https://example.com/small.mp4" }),
      });
      vi.stubGlobal("fetch", fetchMock);
      // Force the non-XHR branch used in happy-dom when we stub carefully:
      // ContaboStorageManagerClient checks typeof XMLHttpRequest.
      const originalXhr = globalThis.XMLHttpRequest;
      // @ts-expect-error -- delete to exercise fetch fallback
      delete globalThis.XMLHttpRequest;

      const client = new ContaboStorageManagerClient("https://example.com/api", "tok");
      const blob = new Blob([new Uint8Array(1024)]);
      const url = await client.uploadMedia("small.bin", blob, "application/octet-stream");

      expect(url).toBe("https://example.com/small.mp4");
      expect(chunkedSpy).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/api/media",
        expect.objectContaining({ method: "POST" }),
      );

      globalThis.XMLHttpRequest = originalXhr;
    });

    it("uses the chunked path for files above the chunk threshold", async () => {
      const chunkedSpy = vi
        .spyOn(storageUpload, "uploadMediaChunked")
        .mockResolvedValue("https://example.com/large.mp4");

      const client = new ContaboStorageManagerClient("https://example.com/api", "tok");
      const blob = new Blob([new Uint8Array(1)]);
      Object.defineProperty(blob, "size", {
        value: CHUNK_THRESHOLD_BYTES + 1,
        configurable: true,
      });
      const url = await client.uploadMedia("large.bin", blob, "application/octet-stream");

      expect(url).toBe("https://example.com/large.mp4");
      expect(chunkedSpy).toHaveBeenCalledTimes(1);
      expect(chunkedSpy.mock.calls[0][0]).toMatchObject({
        mediaEndpoint: "https://example.com/api/media",
        name: "large.bin",
        authHeader: "Bearer tok",
      });
    });
  });
});
