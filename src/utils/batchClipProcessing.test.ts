import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type Clip } from '../types';
import {
  processClipBatch,
  type BatchClipProcessingDeps,
  type BatchProcessingOptions,
} from './batchClipProcessing';

function makeClip(id: string): Clip {
  return {
    id,
    title: `${id}.mp4`,
    kind: 'video',
    file: new File([id], `${id}.mp4`, { type: 'video/mp4' }),
    trimStart: 1,
    trimEnd: 3,
    duration: 5,
  } as Clip;
}

function makeDeps(): BatchClipProcessingDeps {
  return {
    exportSettings: DEFAULT_EXPORT_SETTINGS,
    extractTrimmedVideoClip: vi.fn(async (clip) => new Blob([clip.id])),
    processClipsWithRIFE: vi.fn(async (blobs: Blob[]) =>
      blobs.map((blob) => ({ blob: new Blob([awaitableText(blob)]) })),
    ),
    muxProcessedVideoWithSourceAudio: vi.fn(async (blob) => blob),
    finalizeRenderedVideo: vi.fn(async (blob) => blob),
    getMediaInfo: vi.fn(async () => ({ duration: 2 })),
    onStatus: vi.fn(),
  };
}

function awaitableText(blob: Blob): string {
  return `processed-${blob.size}`;
}

const rifeOptions: BatchProcessingOptions = {
  backend: 'hf-rife',
  multiplier: 4,
  outputFormat: 'prores',
  lightVideoCleanup: true,
  audioCleanup: false,
};

describe('processClipBatch', () => {
  it('runs selected clips through RIFE, restores audio, and applies enabled cleanup', async () => {
    const clips = [makeClip('a'), makeClip('b')];
    const deps = makeDeps();

    const result = await processClipBatch(clips, rifeOptions, deps);

    expect(deps.extractTrimmedVideoClip).toHaveBeenCalledTimes(2);
    expect(deps.processClipsWithRIFE).toHaveBeenCalledWith(
      expect.any(Array),
      4,
      'interpolation',
      expect.any(Function),
      'prores',
    );
    expect(deps.muxProcessedVideoWithSourceAudio).toHaveBeenCalledTimes(2);
    expect(deps.finalizeRenderedVideo).toHaveBeenCalledTimes(2);
    expect(result.map(({ clipId, file, rifeProcessed }) => [
      clipId,
      file.name,
      file.type,
      rifeProcessed,
    ])).toEqual([
      ['a', 'rife_4x_a.mov', 'video/quicktime', true],
      ['b', 'rife_4x_b.mov', 'video/quicktime', true],
    ]);
  });

  it('uses Browser FFmpeg for cleanup without invoking RIFE', async () => {
    const clips = [makeClip('a'), makeClip('b')];
    const deps = makeDeps();
    const options: BatchProcessingOptions = {
      ...rifeOptions,
      backend: 'browser-ffmpeg',
      outputFormat: 'mp4',
      lightVideoCleanup: false,
      audioCleanup: true,
    };

    const result = await processClipBatch(clips, options, deps);

    expect(deps.processClipsWithRIFE).not.toHaveBeenCalled();
    expect(deps.extractTrimmedVideoClip).not.toHaveBeenCalled();
    expect(deps.finalizeRenderedVideo).toHaveBeenCalledTimes(2);
    expect(result.map(({ file, rifeProcessed }) => [file.name, rifeProcessed])).toEqual([
      ['processed_a.mp4', false],
      ['processed_b.mp4', false],
    ]);
  });

  it('rejects Browser FFmpeg batches with no selected operation', async () => {
    await expect(
      processClipBatch(
        [makeClip('a')],
        {
          ...rifeOptions,
          backend: 'browser-ffmpeg',
          outputFormat: 'mp4',
          lightVideoCleanup: false,
          audioCleanup: false,
        },
        makeDeps(),
      ),
    ).rejects.toThrow(/select cleanup or prores/i);
  });
});
