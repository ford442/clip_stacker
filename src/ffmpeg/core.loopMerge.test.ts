import { describe, expect, it, vi } from 'vitest';
import { mergeClipsPass2 } from './core';
import type { IFfmpegRuntime } from './ffmpegRuntime';

function mockFfmpeg(): IFfmpegRuntime {
  return {
    deleteFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(new Uint8Array()),
    exec: vi.fn().mockResolvedValue(undefined),
  } as unknown as IFfmpegRuntime;
}

describe('mergeClipsPass2 (loop concat)', () => {
  it('lists a repeated intermediate filename once per loop cycle in the concat list', async () => {
    const ffmpeg = mockFfmpeg();
    // A 4x-looped clip's pass-1 output ("intermediate-0.mp4") repeated 4 times,
    // followed by a normal clip's single intermediate.
    const names = [
      'intermediate-0.mp4',
      'intermediate-0.mp4',
      'intermediate-0.mp4',
      'intermediate-0.mp4',
      'intermediate-1.mp4',
    ];

    await mergeClipsPass2(ffmpeg, names, vi.fn(), 12, undefined);

    const writeCall = (ffmpeg.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === 'concat_list.txt',
    );
    expect(writeCall).toBeDefined();
    const listContents = writeCall![1] as string;
    const lines = listContents.split('\n');
    expect(lines).toEqual([
      "file 'intermediate-0.mp4'",
      "file 'intermediate-0.mp4'",
      "file 'intermediate-0.mp4'",
      "file 'intermediate-0.mp4'",
      "file 'intermediate-1.mp4'",
    ]);
  });

  it('does not throw when deleting a duplicated intermediate filename twice', async () => {
    const ffmpeg = mockFfmpeg();
    const names = ['intermediate-0.mp4', 'intermediate-0.mp4', 'intermediate-0.mp4'];

    await expect(
      mergeClipsPass2(ffmpeg, names, vi.fn(), 6, undefined),
    ).resolves.toBeUndefined();

    // Deduped: deleteFile is called once for the repeated name, not three times.
    const deleteCalls = (ffmpeg.deleteFile as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0],
    );
    expect(deleteCalls.filter((n) => n === 'intermediate-0.mp4')).toHaveLength(1);
  });
});
