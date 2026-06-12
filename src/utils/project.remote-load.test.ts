import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, Project } from "../types";

const mediaMocks = vi.hoisted(() => ({
  getMediaInfo: vi.fn(),
  createClipId: vi.fn(),
}));

vi.mock("./media", () => ({
  MIN_CLIP_DURATION: 0.1,
  getMediaInfo: mediaMocks.getMediaInfo,
  createClipId: mediaMocks.createClipId,
}));

import { applyProjectData, loadRemoteProject } from "./project";
import type { ContaboStorageManagerClient } from "./project";

function createClip(fileName: string): Clip {
  return {
    id: `clip-${fileName}`,
    file: new File(["local"], fileName, { type: "video/mp4" }),
    objectUrl: `blob:${fileName}`,
    title: fileName,
    kind: "video",
    duration: 4,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

function createRemoteProject(
  fileName: string,
  sourceMediaUrl = `https://example.com/media/${fileName}`,
): Project {
  return {
    clips: [
      {
        id: `saved-${fileName}`,
        title: fileName,
        kind: "video",
        duration: 4,
        trimStart: 0,
        trimEnd: null,
        videoFadeIn: 0,
        videoFadeOut: 0,
        audioFadeIn: 0,
        audioFadeOut: 0,
        fileName,
        fileType: "video/mp4",
        sourceMediaUrl,
      },
    ],
  };
}

function createStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const encodedChunks = chunks.map((chunk) => encoder.encode(chunk));
  const totalBytes = encodedChunks.reduce(
    (sum, chunk) => sum + chunk.byteLength,
    0,
  );
  let index = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= encodedChunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encodedChunks[index++]);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-length": String(totalBytes),
      "content-type": "video/mp4",
    },
  });
}

describe("remote project load progress", () => {
  beforeEach(() => {
    mediaMocks.getMediaInfo.mockReset().mockResolvedValue({
      duration: 4,
      objectUrl: "blob:restored",
    });
    mediaMocks.createClipId.mockReset().mockReturnValue("restored-clip-id");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits manifest and completion progress during remote project load", async () => {
    const existingClip = createClip("local.mp4");
    const client = {
      load: vi.fn().mockResolvedValue({
        clips: [
          {
            id: "saved-local",
            title: "local.mp4",
            kind: "video",
            duration: 4,
            trimStart: 0,
            trimEnd: null,
            videoFadeIn: 0,
            videoFadeOut: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
            fileName: "local.mp4",
          },
        ],
      } satisfies Project),
    } as unknown as ContaboStorageManagerClient;
    const onProgress = vi.fn();

    await loadRemoteProject(client, "demo-project", [existingClip], {
      onProgress,
    });

    expect(onProgress.mock.calls[0][0]).toMatchObject({
      stage: "Fetching project manifest...",
      progress: 0,
      indeterminate: true,
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "Applying remote project data...",
        progress: 0.08,
        indeterminate: true,
      }),
    );
    expect(
      onProgress.mock.calls[onProgress.mock.calls.length - 1]?.[0],
    ).toMatchObject({
      stage: "Remote project load complete",
      progress: 1,
      indeterminate: false,
    });
  });

  it("emits smooth download progress while restoring remote clips", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(createStreamingResponse(["ab", "cd"]));
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    const result = await applyProjectData(
      createRemoteProject("remote.mp4"),
      [],
      { onProgress },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/media/remote.mp4",
    );
    expect(result.clips).toHaveLength(1);
    const restoredFile = mediaMocks.getMediaInfo.mock.calls[0][0] as File;
    expect(restoredFile.name).toBe("remote.mp4");
    expect(restoredFile.type).toBe("video/mp4");

    const downloadEvents = onProgress.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stage === "Downloading clip 1 of 1: remote.mp4");

    expect(downloadEvents[0]).toMatchObject({
      progress: 0,
      indeterminate: true,
      clipIndex: 1,
      clipCount: 1,
      fileName: "remote.mp4",
    });
    expect(
      downloadEvents.some(
        (event) =>
          event.indeterminate === false &&
          typeof event.progress === "number" &&
          event.progress > 0 &&
          event.progress < 1,
      ),
    ).toBe(true);
    expect(downloadEvents[downloadEvents.length - 1]).toMatchObject({
      progress: 1,
      indeterminate: false,
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "Preparing clip 1 of 1: remote.mp4",
        progress: 1,
        indeterminate: true,
      }),
    );
  });

  it("falls back to indeterminate clip progress when streaming details are unavailable", async () => {
    const blob = new Blob(["fallback"], { type: "video/mp4" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "video/mp4" }),
      body: null,
      blob: vi.fn().mockResolvedValue(blob),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const onProgress = vi.fn();

    await applyProjectData(createRemoteProject("fallback.mp4"), [], {
      onProgress,
    });

    const downloadEvents = onProgress.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.stage === "Downloading clip 1 of 1: fallback.mp4",
      );

    expect(downloadEvents).toHaveLength(1);
    expect(downloadEvents[0]).toMatchObject({
      progress: 0,
      indeterminate: true,
    });
    expect(
      downloadEvents.some(
        (event) =>
          event.indeterminate === false &&
          typeof event.progress === "number" &&
          event.progress > 0 &&
          event.progress < 1,
      ),
    ).toBe(false);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "Preparing clip 1 of 1: fallback.mp4",
        progress: 1,
        indeterminate: true,
      }),
    );
  });
});
