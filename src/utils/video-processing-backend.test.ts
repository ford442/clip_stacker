/**
 * Unit tests for src/utils/video-processing-backend.ts
 *
 * The actual RIFE calls are mocked, so these tests focus on:
 *   - createVideoProcessingBackend factory selection
 *   - HuggingFaceRifeBackend delegates to processClipWithRIFE
 *   - SelfHostedRifeBackend isAvailable health-check logic
 *   - SelfHostedRifeBackend processClip builds FormData and parses output
 *   - Progress event shape translation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createVideoProcessingBackend,
  HuggingFaceRifeBackend,
  SelfHostedRifeBackend,
} from "./video-processing-backend";

// ---------------------------------------------------------------------------
// Mock huggingface module so tests don't reach the network
// ---------------------------------------------------------------------------

vi.mock("./huggingface", () => ({
  processClipWithRIFE: vi.fn(),
}));

import { processClipWithRIFE } from "./huggingface";
const mockProcessClipWithRIFE = vi.mocked(processClipWithRIFE);

// ---------------------------------------------------------------------------
// createVideoProcessingBackend
// ---------------------------------------------------------------------------

describe("createVideoProcessingBackend", () => {
  it("returns HuggingFaceRifeBackend when no URL is provided", () => {
    const backend = createVideoProcessingBackend();
    expect(backend).toBeInstanceOf(HuggingFaceRifeBackend);
  });

  it("returns HuggingFaceRifeBackend when null is provided", () => {
    const backend = createVideoProcessingBackend(null);
    expect(backend).toBeInstanceOf(HuggingFaceRifeBackend);
  });

  it("returns HuggingFaceRifeBackend when empty string is provided", () => {
    const backend = createVideoProcessingBackend("");
    expect(backend).toBeInstanceOf(HuggingFaceRifeBackend);
  });

  it("returns HuggingFaceRifeBackend when whitespace-only string is provided", () => {
    const backend = createVideoProcessingBackend("   ");
    expect(backend).toBeInstanceOf(HuggingFaceRifeBackend);
  });

  it("returns SelfHostedRifeBackend when a URL is provided", () => {
    const backend = createVideoProcessingBackend("https://rife.example.com");
    expect(backend).toBeInstanceOf(SelfHostedRifeBackend);
  });

  it("trims whitespace from selfHostedUrl", () => {
    const backend = createVideoProcessingBackend(
      "  https://rife.example.com  ",
    );
    expect(backend).toBeInstanceOf(SelfHostedRifeBackend);
    expect(backend.name).toContain("https://rife.example.com");
  });
});

// ---------------------------------------------------------------------------
// HuggingFaceRifeBackend
// ---------------------------------------------------------------------------

describe("HuggingFaceRifeBackend", () => {
  let backend: HuggingFaceRifeBackend;

  beforeEach(() => {
    backend = new HuggingFaceRifeBackend();
    vi.clearAllMocks();
  });

  it("has a descriptive name", () => {
    expect(backend.name).toContain("HuggingFace");
    expect(backend.name).toContain("RIFE");
  });

  it("isAvailable always returns true", async () => {
    await expect(backend.isAvailable()).resolves.toBe(true);
  });

  it("processClip delegates to processClipWithRIFE", async () => {
    const fakeBlob = new Blob(["video"], { type: "video/mp4" });
    const fakeResult = { blob: new Blob(["result"], { type: "video/mp4" }) };
    mockProcessClipWithRIFE.mockResolvedValueOnce(fakeResult);

    const result = await backend.processClip(fakeBlob, {
      multiplier: 2,
      mode: "interpolation",
    });

    expect(mockProcessClipWithRIFE).toHaveBeenCalledOnce();
    const [calledBlob, calledMult, calledMode] =
      mockProcessClipWithRIFE.mock.calls[0];
    expect(calledBlob).toBe(fakeBlob);
    expect(calledMult).toBe(2);
    expect(calledMode).toBe("interpolation");
    expect(result.blob).toBe(fakeResult.blob);
  });

  it("processClip passes boomerang mode correctly", async () => {
    const fakeBlob = new Blob([], { type: "video/mp4" });
    mockProcessClipWithRIFE.mockResolvedValueOnce({ blob: fakeBlob });

    await backend.processClip(fakeBlob, { multiplier: 4, mode: "boomerang" });

    const [, mult, mode] = mockProcessClipWithRIFE.mock.calls[0];
    expect(mult).toBe(4);
    expect(mode).toBe("boomerang");
  });

  it("processClip translates progress events", async () => {
    const fakeBlob = new Blob([], { type: "video/mp4" });
    mockProcessClipWithRIFE.mockImplementationOnce(
      async (_blob, _mult, _mode, onProgress) => {
        onProgress?.({
          stage: "uploading",
          progress: 50,
          message: "Uploading…",
        });
        return { blob: fakeBlob };
      },
    );

    const events: Array<{ stage: string; progress: number | null }> = [];
    await backend.processClip(
      fakeBlob,
      { multiplier: 2, mode: "interpolation" },
      (e) => {
        events.push({ stage: e.stage, progress: e.progress });
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "uploading", progress: 50 });
  });

  it("processClip works without a progress callback", async () => {
    const fakeBlob = new Blob([], { type: "video/mp4" });
    mockProcessClipWithRIFE.mockResolvedValueOnce({ blob: fakeBlob });

    const result = await backend.processClip(fakeBlob, {
      multiplier: 2,
      mode: "interpolation",
    });
    expect(result.blob).toBe(fakeBlob);
  });
});

// ---------------------------------------------------------------------------
// SelfHostedRifeBackend
// ---------------------------------------------------------------------------

describe("SelfHostedRifeBackend", () => {
  const ENDPOINT = "https://rife.example.com";
  let backend: SelfHostedRifeBackend;

  beforeEach(() => {
    backend = new SelfHostedRifeBackend(ENDPOINT);
    vi.clearAllMocks();
  });

  it("has a name that includes the endpoint URL", () => {
    expect(backend.name).toContain(ENDPOINT);
    expect(backend.name).toContain("RIFE");
  });

  describe("isAvailable", () => {
    it("returns true when the health endpoint responds 200", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true }));
      await expect(backend.isAvailable()).resolves.toBe(true);
      vi.unstubAllGlobals();
    });

    it("returns false when the health endpoint responds non-200", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));
      await expect(backend.isAvailable()).resolves.toBe(false);
      vi.unstubAllGlobals();
    });

    it("returns false when fetch throws (network error)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValueOnce(new Error("Network error")),
      );
      await expect(backend.isAvailable()).resolves.toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe("processClip", () => {
    it("posts to /predict and returns blob from url field", async () => {
      const outputBlob = new Blob(["output"], { type: "video/mp4" });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ url: "https://example.com/result.mp4" }],
          }),
        })
        .mockResolvedValueOnce({ ok: true, blob: async () => outputBlob });

      vi.stubGlobal("fetch", fetchMock);

      const inputBlob = new Blob(["input"], { type: "video/mp4" });
      const result = await backend.processClip(inputBlob, {
        multiplier: 2,
        mode: "interpolation",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [predictUrl, predictOpts] = fetchMock.mock.calls[0];
      expect(predictUrl).toBe(`${ENDPOINT}/predict`);
      expect(predictOpts.method).toBe("POST");
      expect(result.blob).toBe(outputBlob);

      vi.unstubAllGlobals();
    });

    it("throws when /predict returns a non-2xx status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }),
      );

      const inputBlob = new Blob([], { type: "video/mp4" });
      await expect(
        backend.processClip(inputBlob, {
          multiplier: 2,
          mode: "interpolation",
        }),
      ).rejects.toThrow("HTTP 503");

      vi.unstubAllGlobals();
    });

    it("throws when the response contains no data", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [] }),
        }),
      );

      const inputBlob = new Blob([], { type: "video/mp4" });
      await expect(
        backend.processClip(inputBlob, { multiplier: 4, mode: "boomerang" }),
      ).rejects.toThrow("no output");

      vi.unstubAllGlobals();
    });

    it("appends boomerang=true for boomerang mode", async () => {
      const outputBlob = new Blob(["output"], { type: "video/mp4" });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ url: "https://example.com/result.mp4" }],
          }),
        })
        .mockResolvedValueOnce({ ok: true, blob: async () => outputBlob });

      vi.stubGlobal("fetch", fetchMock);

      const inputBlob = new Blob(["input"], { type: "video/mp4" });
      await backend.processClip(inputBlob, {
        multiplier: 4,
        mode: "boomerang",
      });

      // Verify FormData fields include boomerang=true and multiplier=4
      const [, opts] = fetchMock.mock.calls[0];
      const formData = opts.body as FormData;
      expect(formData.get("boomerang")).toBe("true");
      expect(formData.get("multiplier")).toBe("4");

      vi.unstubAllGlobals();
    });

    it("emits progress events during upload and download", async () => {
      const outputBlob = new Blob(["output"], { type: "video/mp4" });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              data: [{ url: "https://example.com/result.mp4" }],
            }),
          })
          .mockResolvedValueOnce({ ok: true, blob: async () => outputBlob }),
      );

      const events: Array<{ stage: string }> = [];
      const inputBlob = new Blob(["input"], { type: "video/mp4" });
      await backend.processClip(
        inputBlob,
        { multiplier: 2, mode: "interpolation" },
        (e) => events.push({ stage: e.stage }),
      );

      const stages = events.map((e) => e.stage);
      expect(stages).toContain("uploading");
      expect(stages).toContain("processing");
      expect(stages).toContain("downloading");

      vi.unstubAllGlobals();
    });
  });
});
