import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockFfmpegInstance = {
  on: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  listDir: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
};

const mocked = vi.hoisted(() => {
  const instances: MockFfmpegInstance[] = [];
  const createInstance = (): MockFfmpegInstance => {
    const instance: MockFfmpegInstance = {
      on: vi.fn(),
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
    FFmpeg: vi.fn(function MockFFmpeg() {
      return createInstance();
    }),
    toBlobURL: vi.fn(),
    fetchFile: vi.fn(),
  };
});

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: mocked.FFmpeg,
}));

vi.mock("@ffmpeg/util", () => ({
  toBlobURL: mocked.toBlobURL,
  fetchFile: mocked.fetchFile,
}));

import {
  ensureFfmpeg,
  isFfmpegLoadFailed,
  resetFFmpegInstance,
} from "./ffmpegService";

describe("FFmpeg loader", () => {
  beforeEach(async () => {
    await resetFFmpegInstance();
    mocked.instances.length = 0;
    mocked.fetchFile.mockReset();
    mocked.toBlobURL.mockReset();
    mocked.FFmpeg.mockReset();
    mocked.FFmpeg.mockImplementation(function MockFFmpeg() {
      return mocked.createInstance();
    });
    mocked.toBlobURL.mockImplementation(async (url: string) => `blob:${url}`);
  });

  afterEach(async () => {
    await resetFFmpegInstance();
    vi.useRealTimers();
  });

  it("downloads locally hosted core assets before any fallback CDN", async () => {
    await ensureFfmpeg(vi.fn(), vi.fn());

    expect(mocked.toBlobURL).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3000/ffmpeg-core/ffmpeg-core.js",
      "text/javascript",
    );
    expect(mocked.toBlobURL).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3000/ffmpeg-core/ffmpeg-core.wasm",
      "application/wasm",
    );
  });

  it("emits indeterminate progress stages while FFmpeg is loading", async () => {
    const onProgress = vi.fn();

    await ensureFfmpeg(vi.fn(), onProgress);

    const stages = onProgress.mock.calls.map(([update]) => update.stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        "Loading FFmpeg core (this may take a moment)...",
        "Downloading FFmpeg core.js from local hosted FFmpeg core...",
        "Downloading FFmpeg core.wasm from local hosted FFmpeg core...",
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

    mocked.FFmpeg.mockImplementationOnce(function MockFFmpegFirst() {
      return first;
    }).mockImplementationOnce(function MockFFmpegSecond() {
      return second;
    });

    const onStatus = vi.fn();
    const onProgress = vi.fn();

    const promise = ensureFfmpeg(onStatus, onProgress);
    // Fast-forward past the first backoff delay (2s)
    await vi.advanceTimersByTimeAsync(2500);

    const result = await promise;
    expect(result).toBe(second);
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

    mocked.FFmpeg.mockImplementation(function MockFFmpegFailing() {
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

  it("surfaces a readable message when the worker rejects with a string", async () => {
    // @ffmpeg/ffmpeg's worker rejects with `error.toString()` (a plain string),
    // not an Error. Previously this surfaced as "FAILED: undefined" because the
    // code read `.message` off a string. The final message must carry the text.
    vi.useFakeTimers();

    const failing = mocked.createInstance();
    failing.load.mockRejectedValue("Error: failed to import ffmpeg-core.js");

    mocked.FFmpeg.mockImplementation(function MockFFmpegStringReject() {
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

  it("clears failed load state so a second manual attempt can succeed", async () => {
    vi.useFakeTimers();

    const first = mocked.createInstance();
    first.load.mockRejectedValue(new Error("network down"));

    mocked.FFmpeg.mockImplementation(function MockFFmpegFailing() {
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

    mocked.FFmpeg.mockImplementation(function MockFFmpegSecond() {
      return second;
    });

    const promise2 = ensureFfmpeg(onStatus, onProgress);
    const result = await promise2;
    expect(result).toBe(second);
    expect(isFfmpegLoadFailed()).toBe(false);
  });
});
