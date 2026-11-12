import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FfmpegCoreHost } from "./ffmpegCoreHost";

type MockCoreHost = {
  load: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  listDir: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
};

const mocked = vi.hoisted(() => {
  const instances: MockCoreHost[] = [];
  const createInstance = (): MockCoreHost => {
    const instance: MockCoreHost = {
      load: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
      listDir: vi.fn().mockResolvedValue([]),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      exec: vi.fn(),
    };
    instances.push(instance);
    return instance;
  };

  return {
    instances,
    createInstance,
    Host: vi.fn(function MockCoreHost() {
      return createInstance();
    }),
    toBlobURL: vi.fn(),
    fetchFile: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("@ffmpeg/util", () => ({
  toBlobURL: mocked.toBlobURL,
  fetchFile: mocked.fetchFile,
}));

import {
  ensureFfmpeg,
  isFfmpegLoadFailed,
  resetFFmpegInstance,
} from "./ffmpegService";
import { DirectFfmpegRuntime } from "./directFfmpegRuntime";
import {
  FfmpegManager,
  resetFfmpegManagerForTesting,
  setFfmpegManagerForTesting,
} from "./ffmpegManager";

/** HEAD answer of a static server that has every self-hosted core file. */
function headOk(url: string): Response {
  const type = url.endsWith(".wasm") ? "application/wasm" : "text/javascript";
  return new Response(null, { status: 200, headers: { "content-type": type } });
}

const LOCAL_ST = "http://localhost:3000/ffmpeg-core";
const LOCAL_MT = "http://localhost:3000/ffmpeg-core-mt";

describe("FFmpeg loader", () => {
  beforeEach(async () => {
    await resetFFmpegInstance();
    resetFfmpegManagerForTesting();
    mocked.instances.length = 0;
    mocked.fetchFile.mockReset();
    mocked.toBlobURL.mockReset();
    mocked.Host.mockReset();
    mocked.Host.mockImplementation(function MockCoreHost() {
      return mocked.createInstance();
    });
    mocked.toBlobURL.mockImplementation(async (url: string) => `blob:${url}`);
    mocked.fetch.mockReset();
    mocked.fetch.mockImplementation(async (url: string) => headOk(url));
    vi.stubGlobal("fetch", mocked.fetch);
    setFfmpegManagerForTesting(
      new FfmpegManager({
        useWorker: false,
        createDirectRuntime: () =>
          new DirectFfmpegRuntime(new mocked.Host() as unknown as FfmpegCoreHost),
      }),
    );
  });

  afterEach(async () => {
    await resetFFmpegInstance();
    resetFfmpegManagerForTesting();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("loads the self-hosted core by URL, with no blob download", async () => {
    await ensureFfmpeg(vi.fn(), vi.fn());

    expect(mocked.fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${LOCAL_ST}/ffmpeg-core.js`, "HEAD"],
      [`${LOCAL_ST}/ffmpeg-core.wasm`, "HEAD"],
    ]);
    expect(mocked.toBlobURL).not.toHaveBeenCalled();
    expect(mocked.instances[0]!.load).toHaveBeenCalledWith({
      coreURL: `${LOCAL_ST}/ffmpeg-core.js`,
      wasmURL: `${LOCAL_ST}/ffmpeg-core.wasm`,
    });
  });

  it("downloads a CDN copy as blob URLs when the self-hosted core is missing", async () => {
    mocked.fetch.mockImplementation(
      async () => new Response(null, { status: 404 }),
    );

    await ensureFfmpeg(vi.fn(), vi.fn());

    expect(mocked.toBlobURL.mock.calls.map(([url]) => url)).toEqual([
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js",
      "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm",
    ]);
    expect(mocked.instances[0]!.load).toHaveBeenCalledWith({
      coreURL: "blob:https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js",
      wasmURL: "blob:https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm",
    });
  });

  it("emits indeterminate progress stages while FFmpeg is loading", async () => {
    const onProgress = vi.fn();

    await ensureFfmpeg(vi.fn(), onProgress);

    const stages = onProgress.mock.calls.map(([update]) => update.stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        "Loading FFmpeg core (this may take a moment)...",
        "Checking FFmpeg core on local hosted FFmpeg core...",
        "Initializing FFmpeg WASM engine...",
      ]),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "Loading FFmpeg core (this may take a moment)...",
        indeterminate: true,
      }),
    );
  });

  it("retries automatically and succeeds on a later attempt", async () => {
    vi.useFakeTimers();

    const first = mocked.createInstance();
    first.load.mockRejectedValueOnce(new Error("network blip"));

    const second = mocked.createInstance();
    second.load.mockResolvedValueOnce(undefined);

    mocked.Host.mockImplementationOnce(function MockCoreHostFirst() {
      return first;
    }).mockImplementationOnce(function MockCoreHostSecond() {
      return second;
    });

    const onStatus = vi.fn();
    const onProgress = vi.fn();

    const promise = ensureFfmpeg(onStatus, onProgress);
    // Fast-forward past the first backoff delay (2s)
    await vi.advanceTimersByTimeAsync(2500);

    const result = await promise;
    expect(result).toBeInstanceOf(DirectFfmpegRuntime);
    expect((result as DirectFfmpegRuntime).underlying).toBe(second);
    expect(first.terminate).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      expect.stringContaining("retrying in 2s (attempt 2/3)"),
    );
    expect(isFfmpegLoadFailed()).toBe(false);
  });

  it("fails after exhausting all retries and surfaces an actionable message", async () => {
    vi.useFakeTimers();

    const failing = mocked.createInstance();
    failing.load.mockRejectedValue(new Error("network down"));

    mocked.Host.mockImplementation(function MockCoreHostFailing() {
      return failing;
    });

    const onStatus = vi.fn();
    const onProgress = vi.fn();

    const promise = ensureFfmpeg(onStatus, onProgress).catch((e) => e);
    // Fast-forward past both backoff delays (2s + 4s)
    await vi.advanceTimersByTimeAsync(7000);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /FFmpeg failed to load after 3 attempts/,
    );
    expect(failing.terminate).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith(
      expect.stringContaining("FFmpeg failed to load after 3 attempts"),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "FFmpeg load failed",
        indeterminate: true,
      }),
    );
    expect(isFfmpegLoadFailed()).toBe(true);
  });

  it("surfaces a readable message when the load rejects with a string", async () => {
    // Worker errors arrive as strings; reading `.message` off one once
    // surfaced "FAILED: undefined". The final message must carry the text.
    vi.useFakeTimers();

    const failing = mocked.createInstance();
    failing.load.mockRejectedValue("Error: failed to import ffmpeg-core.js");

    mocked.Host.mockImplementation(function MockCoreHostStringReject() {
      return failing;
    });

    const onStatus = vi.fn();

    const promise = ensureFfmpeg(onStatus, vi.fn()).catch((e) => e);
    await vi.advanceTimersByTimeAsync(7000);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("failed to import ffmpeg-core.js");
    expect((err as Error).message).not.toContain("undefined");
  });

  describe("multi-threaded / single-threaded variant selection", () => {
    function mockIsolatedContext(isolated: boolean) {
      const orig = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
      Object.defineProperty(globalThis, 'crossOriginIsolated', {
        configurable: true,
        get: () => isolated,
      });
      return () => {
        if (orig) {
          Object.defineProperty(globalThis, 'crossOriginIsolated', orig);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (globalThis as any).crossOriginIsolated;
        }
      };
    }

    it("loads single-threaded when not cross-origin isolated", async () => {
      const restore = mockIsolatedContext(false);
      try {
        await ensureFfmpeg(vi.fn(), vi.fn());
        const probed = mocked.fetch.mock.calls.map(([url]) => String(url));
        expect(probed.every((url) => url.startsWith(`${LOCAL_ST}/`))).toBe(true);
        expect(probed.some((url) => url.includes("core-mt"))).toBe(false);
        expect(mocked.instances[0]!.load).toHaveBeenCalledWith(
          expect.not.objectContaining({ workerURL: expect.anything() }),
        );
      } finally {
        restore();
      }
    });

    it("loads the self-hosted multi-threaded core (js + wasm + worker) by URL", async () => {
      const restore = mockIsolatedContext(true);
      try {
        await ensureFfmpeg(vi.fn(), vi.fn());
        expect(mocked.fetch.mock.calls.map(([url]) => url)).toEqual([
          `${LOCAL_MT}/ffmpeg-core.js`,
          `${LOCAL_MT}/ffmpeg-core.wasm`,
          `${LOCAL_MT}/ffmpeg-core.worker.js`,
        ]);
        expect(mocked.toBlobURL).not.toHaveBeenCalled();
        expect(mocked.instances[0]!.load).toHaveBeenCalledWith({
          coreURL: `${LOCAL_MT}/ffmpeg-core.js`,
          wasmURL: `${LOCAL_MT}/ffmpeg-core.wasm`,
          workerURL: `${LOCAL_MT}/ffmpeg-core.worker.js`,
        });
      } finally {
        restore();
      }
    });

    it("takes all three mt files from one CDN when the local mt core is unavailable", async () => {
      const restore = mockIsolatedContext(true);
      try {
        mocked.fetch.mockImplementation(async (url: string) =>
          url.includes("/ffmpeg-core-mt/")
            ? new Response(null, { status: 404 })
            : headOk(url),
        );
        await ensureFfmpeg(vi.fn(), vi.fn());

        const jsdelivr = "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm";
        expect(mocked.toBlobURL.mock.calls).toEqual([
          [`${jsdelivr}/ffmpeg-core.js`, "text/javascript"],
          [`${jsdelivr}/ffmpeg-core.wasm`, "application/wasm"],
          [`${jsdelivr}/ffmpeg-core.worker.js`, "text/javascript"],
        ]);
        expect(mocked.instances[0]!.load).toHaveBeenCalledWith({
          coreURL: `blob:${jsdelivr}/ffmpeg-core.js`,
          wasmURL: `blob:${jsdelivr}/ffmpeg-core.wasm`,
          workerURL: `blob:${jsdelivr}/ffmpeg-core.worker.js`,
        });
      } finally {
        restore();
      }
    });

    it("falls back to single-threaded when multi-threaded load fails", async () => {
      vi.useFakeTimers();
      const restore = mockIsolatedContext(true);
      try {
        // No mt core anywhere; st URLs succeed normally.
        mocked.fetch.mockImplementation(async (url: string) =>
          url.includes("core-mt") ? new Response(null, { status: 404 }) : headOk(url),
        );
        mocked.toBlobURL.mockImplementation(async (url: string) => {
          if (url.includes("core-mt")) throw new Error("mt CDN unavailable");
          return `blob:${url}`;
        });

        const onStatus = vi.fn();
        const promise = ensureFfmpeg(onStatus, vi.fn());
        // Advance past all mt retry backoffs (3 retries × 2 CDNs × backoff ≈ 36s+).
        await vi.advanceTimersByTimeAsync(200_000);

        const result = await promise;
        expect(result).toBeInstanceOf(DirectFfmpegRuntime);
        // Status message must mention single-threaded fallback.
        expect(onStatus).toHaveBeenCalledWith(
          expect.stringContaining("single-threaded"),
        );
        expect(mocked.instances.at(-1)!.load).toHaveBeenCalledWith({
          coreURL: `${LOCAL_ST}/ffmpeg-core.js`,
          wasmURL: `${LOCAL_ST}/ffmpeg-core.wasm`,
        });
      } finally {
        restore();
        vi.useRealTimers();
      }
    });
  });

  it("clears failed load state so a second manual attempt can succeed", async () => {
    vi.useFakeTimers();

    const first = mocked.createInstance();
    first.load.mockRejectedValue(new Error("network down"));

    mocked.Host.mockImplementation(function MockCoreHostFailing() {
      return first;
    });

    const onStatus = vi.fn();
    const onProgress = vi.fn();

    const promise1 = ensureFfmpeg(onStatus, onProgress).catch((e) => e);
    await vi.advanceTimersByTimeAsync(7000);
    const err = await promise1;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /FFmpeg failed to load after 3 attempts/,
    );
    expect(isFfmpegLoadFailed()).toBe(true);

    // Reset and try again
    await resetFFmpegInstance();

    const second = mocked.createInstance();
    second.load.mockResolvedValueOnce(undefined);

    mocked.Host.mockImplementation(function MockCoreHostSecond() {
      return second;
    });

    const promise2 = ensureFfmpeg(onStatus, onProgress);
    const result = await promise2;
    expect(result).toBeInstanceOf(DirectFfmpegRuntime);
    expect((result as DirectFfmpegRuntime).underlying).toBe(second);
    expect(isFfmpegLoadFailed()).toBe(false);
  });
});
