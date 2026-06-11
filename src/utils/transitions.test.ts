import { describe, it, expect } from "vitest";
import type { Clip, ClipTransition } from "../types";
import {
  getEffectiveDurations,
  computeTransitionOffsets,
  computeTotalDuration,
  createDefaultTransitions,
  reindexTransitions,
  buildTransitionFilterComplex,
} from "./transitions";

// Helper to create a minimal test clip
function createTestClip(
  id: string,
  duration: number,
  trimStart = 0,
  trimEnd = NaN,
): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: "video",
    duration,
    trimStart,
    trimEnd,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe("utils/transitions", () => {
  // =========================================================================
  // getEffectiveDurations
  // =========================================================================
  describe("getEffectiveDurations", () => {
    it("should return durations for clips with no trim", () => {
      const clips = [
        createTestClip("a", 5),
        createTestClip("b", 3),
        createTestClip("c", 2),
      ];
      const result = getEffectiveDurations(clips);
      expect(result).toEqual([5, 3, 2]);
    });

    it("should compute effective duration from trimStart and trimEnd", () => {
      const clips = [
        createTestClip("a", 10, 1, 6), // 6 - 1 = 5 seconds
        createTestClip("b", 10, 2, 7), // 7 - 2 = 5 seconds
      ];
      const result = getEffectiveDurations(clips);
      expect(result).toEqual([5, 5]);
    });

    it("should enforce MIN_CLIP_DURATION when trimmed duration is too short", () => {
      // MIN_CLIP_DURATION = 0.1
      const clips = [
        createTestClip("a", 10, 5, 5.05), // 0.05, should be clamped to MIN_CLIP_DURATION
      ];
      const result = getEffectiveDurations(clips);
      expect(result[0]).toBe(0.1); // MIN_CLIP_DURATION
    });
  });

  // =========================================================================
  // computeTransitionOffsets
  // =========================================================================
  describe("computeTransitionOffsets", () => {
    it("should compute offsets for simple transitions", () => {
      const durations = [5, 3, 2];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
        { afterClipIndex: 2, type: "dissolve", duration: 0.5 },
      ];
      const offsets = computeTransitionOffsets(durations, transitions);
      // First transition starts at 5 - 0.5 = 4.5
      expect(offsets[0]).toBe(4.5);
      // Second transition: accumulated = 8, overlap = 0.5, so 8 - 0.5 - 0.5 = 7
      expect(offsets[1]).toBe(7);
    });

    it("should mark no transition as -1", () => {
      const durations = [5, 3];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "none", duration: 0 },
      ];
      const offsets = computeTransitionOffsets(durations, transitions);
      expect(offsets[0]).toBe(-1);
    });

    it('should handle transitions with type "none" as no transition', () => {
      const durations = [5, 3];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "none", duration: 0.5 },
      ];
      const offsets = computeTransitionOffsets(durations, transitions);
      expect(offsets[0]).toBe(-1);
    });
  });

  // =========================================================================
  // computeTotalDuration
  // =========================================================================
  describe("computeTotalDuration", () => {
    it("should compute total duration without transitions", () => {
      const clips = [createTestClip("a", 5), createTestClip("b", 3)];
      const transitions: ClipTransition[] = [];
      const duration = computeTotalDuration(clips, transitions);
      expect(duration).toBe(8);
    });

    it("should subtract transition overlaps from total duration", () => {
      const clips = [
        createTestClip("a", 5),
        createTestClip("b", 3),
        createTestClip("c", 2),
      ];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
        { afterClipIndex: 2, type: "dissolve", duration: 0.3 },
      ];
      const duration = computeTotalDuration(clips, transitions);
      // 5 + 3 + 2 - 0.5 - 0.3 = 9.2
      expect(duration).toBe(9.2);
    });

    it('should ignore transitions with type "none"', () => {
      const clips = [createTestClip("a", 5), createTestClip("b", 3)];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "none", duration: 0.5 },
      ];
      const duration = computeTotalDuration(clips, transitions);
      // No overlap is applied because type is 'none'
      expect(duration).toBe(8);
    });
  });

  // =========================================================================
  // createDefaultTransitions
  // =========================================================================
  describe("createDefaultTransitions", () => {
    it("should create dissolve transitions between clips", () => {
      const clips = [
        createTestClip("a", 5),
        createTestClip("b", 3),
        createTestClip("c", 2),
      ];
      const transitions = createDefaultTransitions(clips);
      expect(transitions).toHaveLength(2);
      expect(transitions[0]).toEqual({
        afterClipIndex: 1,
        type: "dissolve",
        duration: 0.5,
      });
      expect(transitions[1]).toEqual({
        afterClipIndex: 2,
        type: "dissolve",
        duration: 0.5,
      });
    });

    it("should return empty array for single clip", () => {
      const clips = [createTestClip("a", 5)];
      const transitions = createDefaultTransitions(clips);
      expect(transitions).toHaveLength(0);
    });
  });

  // =========================================================================
  // reindexTransitions
  // =========================================================================
  describe("reindexTransitions", () => {
    it("should remove transition at removed index", () => {
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
        { afterClipIndex: 2, type: "dissolve", duration: 0.5 },
        { afterClipIndex: 3, type: "dissolve", duration: 0.5 },
      ];
      const result = reindexTransitions(transitions, 2);
      expect(result).toHaveLength(2);
      // afterClipIndex 1 stays the same
      expect(result[0].afterClipIndex).toBe(1);
      // afterClipIndex 3 becomes 2
      expect(result[1].afterClipIndex).toBe(2);
    });

    it("should adjust indices after removed clip", () => {
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
        { afterClipIndex: 2, type: "dissolve", duration: 0.5 },
      ];
      const result = reindexTransitions(transitions, 0);
      // afterClipIndex 1 becomes 0
      expect(result[0].afterClipIndex).toBe(0);
      // afterClipIndex 2 becomes 1
      expect(result[1].afterClipIndex).toBe(1);
    });

    it("should not adjust indices before removed clip", () => {
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
        { afterClipIndex: 2, type: "dissolve", duration: 0.5 },
      ];
      const result = reindexTransitions(transitions, 5);
      expect(result).toHaveLength(2);
      expect(result[0].afterClipIndex).toBe(1);
      expect(result[1].afterClipIndex).toBe(2);
    });
  });

  // =========================================================================
  // buildTransitionFilterComplex
  // =========================================================================
  describe("buildTransitionFilterComplex", () => {
    it("should return null if no active transitions", () => {
      const clips = [createTestClip("a", 5), createTestClip("b", 3)];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "none", duration: 0 },
      ];
      const filterComplex = buildTransitionFilterComplex(clips, transitions);
      expect(filterComplex).toBeNull();
    });

    it("should build filter complex with transitions", () => {
      const clips = [
        createTestClip("a", 5, 0, NaN),
        createTestClip("b", 3, 0, NaN),
      ];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
      ];
      const filterComplex = buildTransitionFilterComplex(clips, transitions);
      expect(filterComplex).toBeTruthy();
      // Should contain xfade and acrossfade filters
      expect(filterComplex).toContain("xfade");
      expect(filterComplex).toContain("acrossfade");
    });

    it('should map "dissolve" to "fade" xfade type', () => {
      const clips = [
        createTestClip("a", 5, 0, NaN),
        createTestClip("b", 3, 0, NaN),
      ];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
      ];
      const filterComplex = buildTransitionFilterComplex(clips, transitions);
      expect(filterComplex).toContain("transition=fade");
    });

    it('should map "motion" to "smoothleft" xfade type', () => {
      const clips = [
        createTestClip("a", 5, 0, NaN),
        createTestClip("b", 3, 0, NaN),
      ];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "motion", duration: 0.5 },
      ];
      const filterComplex = buildTransitionFilterComplex(clips, transitions);
      expect(filterComplex).toContain("transition=smoothleft");
    });

    it("should handle video and audio clips correctly", () => {
      const clips = [
        { ...createTestClip("a", 5), kind: "video" as const },
        { ...createTestClip("b", 3), kind: "audio" as const },
      ];
      const transitions: ClipTransition[] = [
        { afterClipIndex: 1, type: "dissolve", duration: 0.5 },
      ];
      const filterComplex = buildTransitionFilterComplex(clips, transitions);
      expect(filterComplex).toBeTruthy();
      // Audio-only clips should generate black video
      expect(filterComplex).toContain("color=c=black");
    });
  });
});
