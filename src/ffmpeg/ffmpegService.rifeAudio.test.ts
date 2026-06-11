import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip } from "../types";

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
      readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      exec: vi.fn().mockResolvedValue(undefined),
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
  muxProcessedVideoWithSourceAudio,
  resetFFmpegInstance,
} from "./ffmpegService";

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "clip-1",
    file: new File([new Uint8Array([7, 8, 9])], "source.mp4", {
      type: "video/mp4",
    }),
    objectUrl: "blob:clip-1",
    title: "Clip 1",
    kind: "video",
    duration: 10,
    trimStart: 1.25,
    trimEnd: 4.5,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

describe("muxProcessedVideoWithSourceAudio", () => {
  beforeEach(async () => {
    await resetFFmpegInstance();
    mocked.instances.length = 0;
    mocked.fetchFile.mockReset();
    mocked.toBlobURL.mockReset();
    mocked.FFmpeg.mockReset();
    mocked.FFmpeg.mockImplementation(function MockFFmpeg() {
      return mocked.createInstance();
    });
    mocked.fetchFile.mockResolvedValue(new Uint8Array([7, 8, 9]));
    mocked.toBlobURL.mockImplementation(async (url: string) => `blob:${url}`);
  });

  afterEach(async () => {
    await resetFFmpegInstance();
  });

  it("maps processed video with trimmed source audio into the output mp4", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
    const clip = makeClip();
    const onStatus = vi.fn();

    const result = await muxProcessedVideoWithSourceAudio(blob, clip, onStatus);

    const instance = mocked.instances[mocked.instances.length - 1]!;
    expect(instance.exec).toHaveBeenCalledWith([
      "-i",
      "processed-video.mp4",
      "-i",
      "source-audio.mp4",
      "-filter_complex",
      "[1:a]atrim=start=1.25:end=4.5,asetpts=PTS-STARTPTS[aout]",
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "processed-with-audio.mp4",
    ]);
    expect(mocked.fetchFile).toHaveBeenCalledWith(clip.file);
    expect(result.type).toBe("video/mp4");
    expect(onStatus).toHaveBeenCalledWith("Source audio restored.");
  });
});
