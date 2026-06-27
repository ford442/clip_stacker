/**
 * Unit tests for stitchClipsOnGpu in src/utils/huggingface.ts.
 *
 * @gradio/client is mocked so tests never touch the network. They focus on:
 *   - the empty-input guard
 *   - the positional payload sent to the "/stitch" endpoint
 *   - resolving the Gradio file output (Blob / URL string / { url }) to a Blob
 *   - progress event ordering
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPredict = vi.fn();
const mockConnect = vi.fn(async () => ({ predict: mockPredict }));

vi.mock("@gradio/client", () => ({
  Client: { connect: (...args: unknown[]) => mockConnect(...args) },
}));

import { stitchClipsOnGpu } from "./huggingface";

function makeBlob(text = "clip"): Blob {
  return new Blob([text], { type: "video/mp4" });
}

describe("stitchClipsOnGpu", () => {
  beforeEach(() => {
    mockPredict.mockReset();
    mockConnect.mockClear();
  });

  it("rejects when there are no clips to stitch", async () => {
    await expect(stitchClipsOnGpu([], "1920x1080")).rejects.toThrow(
      /no video clips/i,
    );
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("sends clips, resolution, and default audio args to /stitch", async () => {
    const outBlob = makeBlob("stitched");
    mockPredict.mockResolvedValue({ data: [outBlob] });

    const clips = [makeBlob("a"), makeBlob("b")];
    const result = await stitchClipsOnGpu(clips, "1280x720");

    expect(mockConnect).toHaveBeenCalledWith("1inkusFace/RIFE");
    const [endpoint, payload] = mockPredict.mock.calls[0];
    expect(endpoint).toBe("/stitch");
    expect(payload[0]).toBe(clips);
    expect(payload[1]).toBe("1280x720");
    expect(payload[2]).toBeNull();
    expect(payload[3]).toBe("Keep original audio");
    expect(result.blob).toBe(outBlob);
  });

  it("downloads the output when the space returns a { url } object", async () => {
    const downloaded = makeBlob("downloaded");
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => downloaded });
    vi.stubGlobal("fetch", fetchMock);

    mockPredict.mockResolvedValue({
      data: [{ url: "https://example.com/out.mp4" }],
    });

    const result = await stitchClipsOnGpu([makeBlob()], "1920x1080");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/out.mp4");
    expect(result.blob).toBe(downloaded);

    vi.unstubAllGlobals();
  });

  it("emits uploading → processing → downloading progress events", async () => {
    mockPredict.mockResolvedValue({ data: [makeBlob("stitched")] });
    const stages: string[] = [];

    await stitchClipsOnGpu([makeBlob()], "1920x1080", (e) =>
      stages.push(e.stage),
    );

    expect(stages[0]).toBe("uploading");
    expect(stages).toContain("processing");
    expect(stages[stages.length - 1]).toBe("downloading");
  });

  it("wraps prediction errors with a GPU stitch message", async () => {
    mockPredict.mockRejectedValue(new Error("boom"));
    await expect(stitchClipsOnGpu([makeBlob()], "1920x1080")).rejects.toThrow(
      /GPU stitch failed: boom/,
    );
  });
});
