import type { Clip } from "../types";

/**
 * Helper to create a minimal test clip
 */
export function createTestClip(
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
