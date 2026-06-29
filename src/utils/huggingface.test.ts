/**
 * Unit tests for stitchClipsOnGpu in src/utils/huggingface.ts.
 *
 * The Space is reached through the raw Gradio HTTP API (NOT @gradio/client,
 * which hardcodes credentials:"include" and fails CORS against HF's wildcard
 * origin). `fetch` is mocked to walk the upload → /call → SSE → download flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processClipWithRIFE, stitchClipsOnGpu } from "./huggingface";

function makeBlob(text = "clip"): Blob {
  return new Blob([text], { type: "video/mp4" });
}

/** Minimal MP4 header so assertValidMp4Blob passes in tests. */
function makeMp4Blob(text = "clip"): Blob {
  const header = new Uint8Array([
    0, 0, 0, 20,
    0x66, 0x74, 0x79, 0x70, // ftyp
    0x69, 0x73, 0x6f, 0x6d,
    0, 0, 0, 0,
  ]);
  const body = new TextEncoder().encode(text);
  const merged = new Uint8Array(header.length + body.length);
  merged.set(header);
  merged.set(body, header.length);
  return new Blob([merged], { type: "video/mp4" });
}

/** Build a Response-like object for the mocked fetch. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A Response whose body streams the given SSE text once. */
function sseResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () =>
            sent
              ? { value: undefined, done: true }
              : ((sent = true), { value: bytes, done: false }),
        };
      },
    },
  } as unknown as Response;
}

const COMPLETE_SSE =
  'event: complete\ndata: [{"path":"/tmp/out.mp4","url":"https://1inkusface-rife.hf.space/gradio_api/file=/tmp/out.mp4"}]\n\n';

describe("stitchClipsOnGpu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when there are no clips to stitch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(stitchClipsOnGpu([], "1920x1080")).rejects.toThrow(
      /no video clips/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads, calls /stitch, and downloads the result without credentials", async () => {
    const stitched = makeMp4Blob("stitched");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/upload")) return jsonResponse(["/tmp/clip_0.mp4"]);
      if (url.endsWith("/call/stitch")) return jsonResponse({ event_id: "ev1" });
      if (url.includes("/call/stitch/ev1")) return sseResponse(COMPLETE_SSE);
      if (url.includes("file=")) {
        return { ok: true, status: 200, blob: async () => stitched } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ""}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await stitchClipsOnGpu([makeBlob("a")], "1280x720");
    expect(result.blob).toBe(stitched);

    // Every request must omit credentials (the whole point of the rework).
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.credentials).toBe("omit");
    }

    // The /call payload carries FileData + resolution + default audio args.
    const callInvocation = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith("/call/stitch"),
    );
    const body = JSON.parse((callInvocation![1] as RequestInit).body as string);
    expect(body.data[0]).toEqual([
      { path: "/tmp/clip_0.mp4", meta: { _type: "gradio.FileData" } },
    ]);
    expect(body.data[1]).toBe("1280x720");
    expect(body.data[3]).toBe("Keep original audio");
  });

  it("surfaces an error event from the result stream", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse(["/tmp/clip_0.mp4"]);
      if (url.endsWith("/call/stitch")) return jsonResponse({ event_id: "ev1" });
      if (url.includes("/call/stitch/ev1"))
        return sseResponse('event: error\ndata: null\n\n');
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(stitchClipsOnGpu([makeBlob()], "1920x1080")).rejects.toThrow(
      /GPU stitch failed.*cold start/i,
    );
  });

  it("fails clearly when the upload is rejected", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(null, false, 503),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(stitchClipsOnGpu([makeBlob()], "1920x1080")).rejects.toThrow(
      /GPU stitch failed/,
    );
  });

  it("emits uploading → processing → downloading progress events", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse(["/tmp/clip_0.mp4"]);
      if (url.endsWith("/call/stitch")) return jsonResponse({ event_id: "ev1" });
      if (url.includes("/call/stitch/ev1")) return sseResponse(COMPLETE_SSE);
      return { ok: true, status: 200, blob: async () => makeMp4Blob() } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const stages: string[] = [];
    await stitchClipsOnGpu([makeBlob()], "1920x1080", (e) =>
      stages.push(e.stage),
    );
    expect(stages[0]).toBe("uploading");
    expect(stages).toContain("processing");
    expect(stages[stages.length - 1]).toBe("downloading");
  });

  it("fails clearly when the space returns an empty file reference", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse(["/tmp/clip_0.mp4"]);
      if (url.endsWith("/call/stitch")) return jsonResponse({ event_id: "ev1" });
      if (url.includes("/call/stitch/ev1"))
        return sseResponse('event: complete\ndata: [{}]\n\n');
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(stitchClipsOnGpu([makeBlob()], "1920x1080")).rejects.toThrow(
      /GPU stitch failed.*no output/i,
    );
  });

  it("rejects non-video download payloads with a preview", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse(["/tmp/clip_0.mp4"]);
      if (url.endsWith("/call/stitch")) return jsonResponse({ event_id: "ev1" });
      if (url.includes("/call/stitch/ev1")) return sseResponse(COMPLETE_SSE);
      if (url.includes("file=")) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(["Gradio error: queue full"], { type: "text/plain" }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(stitchClipsOnGpu([makeBlob()], "1920x1080")).rejects.toThrow(
      /Unexpected stitched video output format.*Gradio error/i,
    );
  });

  it("accepts a bare server path string in the complete payload", async () => {
    const stitched = makeMp4Blob("path-string");
    const sse =
      'event: complete\ndata: ["/tmp/out.mp4"]\n\n';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse(["/tmp/clip_0.mp4"]);
      if (url.endsWith("/call/stitch")) return jsonResponse({ event_id: "ev1" });
      if (url.includes("/call/stitch/ev1")) return sseResponse(sse);
      if (url.includes("file=")) {
        return { ok: true, status: 200, blob: async () => stitched } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await stitchClipsOnGpu([makeBlob()], "1280x720");
    expect(result.blob).toBe(stitched);
  });
});

describe("processClipWithRIFE", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads + calls /interpolate_video with credentials omitted", async () => {
    const processed = makeMp4Blob("rife");
    const sse =
      'event: complete\ndata: [{"url":"https://1inkusface-rife.hf.space/gradio_api/file=/tmp/r.mp4"}]\n\n';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/upload")) return jsonResponse(["/tmp/in.mp4"]);
      if (url.endsWith("/call/interpolate_video"))
        return jsonResponse({ event_id: "ev1" });
      if (url.includes("/call/interpolate_video/ev1")) return sseResponse(sse);
      return { ok: true, status: 200, blob: async () => processed } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await processClipWithRIFE(makeBlob(), 4, "boomerang");
    expect(result.blob).toBe(processed);

    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith("/call/interpolate_video"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.data[0]).toEqual({
      path: "/tmp/in.mp4",
      meta: { _type: "gradio.FileData" },
    });
    expect(body.data[1]).toBe("4");
    expect(body.data[2]).toBe(true);
    for (const c of fetchMock.mock.calls) {
      expect((c[1] as RequestInit | undefined)?.credentials).toBe("omit");
    }
  });
});
