import { describe, it, expect, vi } from "vitest";
import type { Clip } from "../types";
import {
  serializeProjectWithMedia,
  MAX_EMBED_FILE_BYTES,
  MAX_UPLOAD_RETRY_ATTEMPTS,
  ContaboStorageManagerClient,
} from "./project";
import { createTestClip } from "./project.test.helpers";

describe("utils/project - serializeProjectWithMedia", () => {
  // =========================================================================
  // Remote upload retries
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
  // Large file embed handling
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
});
