import { describe, it, expect } from "vitest";
import { sanitizeClipAdjustments } from "./project";
import { createTestClip } from "./project.test.helpers";

describe("utils/project - sanitizeClipAdjustments", () => {
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

  it("should clamp playbackRate to 0.25–4", () => {
    const clip = createTestClip("test", 5);
    clip.playbackRate = 0.1;
    sanitizeClipAdjustments(clip);
    expect(clip.playbackRate).toBe(0.25);

    clip.playbackRate = 9;
    sanitizeClipAdjustments(clip);
    expect(clip.playbackRate).toBe(4);
  });
});
