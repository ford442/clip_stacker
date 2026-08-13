import { describe, it, expect } from "vitest";
import { getClipDuration } from "./project";
import { createTestClip } from "./project.test.helpers";

describe("utils/project - getClipDuration", () => {
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

  it("should divide trimmed length by playbackRate", () => {
    const clip = createTestClip("test", 10);
    clip.trimStart = 0;
    clip.trimEnd = 10;
    clip.playbackRate = 2;
    expect(getClipDuration(clip)).toBe(5);
    clip.playbackRate = 0.5;
    expect(getClipDuration(clip)).toBe(20);
  });
});
