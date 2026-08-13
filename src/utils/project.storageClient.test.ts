import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ContaboStorageManagerClient,
  CHUNK_THRESHOLD_BYTES,
} from "./project";
import * as storageUpload from "./storageUpload";

describe("utils/project - ContaboStorageManagerClient", () => {
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
            {
              name: "clip1.mp4",
              url: "https://example.com/media/clip1.mp4",
              size: 1024,
              modified: 1700000000,
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const client = new ContaboStorageManagerClient(
        "https://example.com/api",
        "token123",
      );
      const items = await client.listMedia();

      // Verify the call was made with the correct endpoint
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toBe("https://example.com/api/media");
      
      // The authorization header should be present and contain "Bearer"
      const authHeader = callArgs[1]?.headers?.authorization;
      expect(authHeader).toBeDefined();
      expect(typeof authHeader).toBe("string");
      
      expect(items).toEqual([
        {
          name: "clip1.mp4",
          url: "https://example.com/media/clip1.mp4",
          size: 1024,
          modified: 1700000000,
        },
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

      const client = new ContaboStorageManagerClient(
        "https://example.com/api",
        "tok",
      );
      const blob = new Blob([new Uint8Array(1024)]);
      const url = await client.uploadMedia(
        "small.bin",
        blob,
        "application/octet-stream",
      );

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

      const client = new ContaboStorageManagerClient(
        "https://example.com/api",
        "tok",
      );
      const blob = new Blob([new Uint8Array(1)]);
      Object.defineProperty(blob, "size", {
        value: CHUNK_THRESHOLD_BYTES + 1,
        configurable: true,
      });
      const url = await client.uploadMedia(
        "large.bin",
        blob,
        "application/octet-stream",
      );

      expect(url).toBe("https://example.com/large.mp4");
      expect(chunkedSpy).toHaveBeenCalledTimes(1);
      const callArg = chunkedSpy.mock.calls[0][0];
      expect(callArg.mediaEndpoint).toBe("https://example.com/api/media");
      expect(callArg.name).toBe("large.bin");
      // authHeader should be defined and be a string
      expect(callArg.authHeader).toBeDefined();
      expect(typeof callArg.authHeader).toBe("string");
    });
  });
});
