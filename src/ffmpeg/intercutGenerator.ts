import { fetchFile } from '@ffmpeg/util';
import type { Clip } from '../types';
import { getSafeExtension } from './core';
import {
  buildConcatPlaylist,
  buildIntercutSlices,
  canUseStreamCopyForIntercut,
  type FrequencyAutomationConfig,
  type IntercutSlice,
} from '../utils/intercut';
import type { IFfmpegRuntime } from './ffmpegRuntime';
import { ensureFfmpeg, safeExec, safeWriteFile, safeReadFile } from './core';
import type { StatusCallback } from './ffmpegCommon';

export interface IntercutGeneratorConfig {
  clipA: Clip;
  clipB: Clip;
  automation: FrequencyAutomationConfig;
  /** When true, always re-encode (needed for strobe / short slices). */
  forceReencode?: boolean;
}

export interface IntercutGeneratorResult {
  blob: Blob;
  slices: IntercutSlice[];
  usedStreamCopy: boolean;
  outputDurationSec: number;
}

function sourceBounds(clip: Clip): { trimStart: number; trimEnd: number } {
  return {
    trimStart: clip.trimStart,
    trimEnd: Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration,
  };
}

export function planIntercutSlices(config: IntercutGeneratorConfig): IntercutSlice[] {
  return buildIntercutSlices({
    sourceA: sourceBounds(config.clipA),
    sourceB: sourceBounds(config.clipB),
    automation: config.automation,
  });
}

/**
 * Generate an intercut MP4 from two clips already written to the FFmpeg VFS.
 */
export async function generateIntercutFromVfs(
  ffmpeg: IFfmpegRuntime,
  vfsNameA: string,
  vfsNameB: string,
  config: IntercutGeneratorConfig,
  onStatus: StatusCallback,
  outputName = 'intercut_output.mp4',
): Promise<Omit<IntercutGeneratorResult, 'blob'>> {
  const slices = planIntercutSlices(config);
  if (slices.length === 0) {
    throw new Error(
      'Intercut produced zero slices — check clip durations and automation settings.',
    );
  }

  const useCopy = !config.forceReencode && canUseStreamCopyForIntercut(slices);
  const playlistName = 'intercut_playlist.txt';
  const playlist = buildConcatPlaylist(slices, vfsNameA, vfsNameB);

  await safeWriteFile(ffmpeg, playlistName, playlist, 'intercut concat playlist');
  onStatus(
    `Intercut: stitching ${slices.length} slice${slices.length === 1 ? '' : 's'} (${useCopy ? 'stream copy' : 're-encode'})…`,
  );

  const args: string[] = ['-f', 'concat', '-safe', '0', '-i', playlistName];
  if (useCopy) {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', outputName);
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outputName,
    );
  }

  await safeExec(ffmpeg, args, null, `intercut generate (${slices.length} slices)`);

  try {
    await ffmpeg.deleteFile(playlistName);
  } catch {
    /* ignore */
  }

  const outputDurationSec = slices.reduce(
    (sum, s) => sum + (s.outpoint - s.inpoint),
    0,
  );

  return { slices, usedStreamCopy: useCopy, outputDurationSec };
}

/**
 * End-to-end: write two clips to FFmpeg VFS, build dynamic intercut, return MP4 blob.
 */
export async function generateIntercutClip(
  config: IntercutGeneratorConfig,
  onStatus: StatusCallback,
): Promise<IntercutGeneratorResult> {
  const ffmpeg = await ensureFfmpeg(onStatus);
  const extA = getSafeExtension(config.clipA.file.name, 'mp4');
  const extB = getSafeExtension(config.clipB.file.name, 'mp4');
  const vfsNameA = `intercut-a.${extA}`;
  const vfsNameB = `intercut-b.${extB}`;
  const outputName = 'intercut_output.mp4';

  for (const name of [vfsNameA, vfsNameB, outputName]) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }

  onStatus('Preparing clips for intercut…');
  await safeWriteFile(
    ffmpeg,
    vfsNameA,
    await fetchFile(config.clipA.file),
    'intercut write clip A',
  );
  await safeWriteFile(
    ffmpeg,
    vfsNameB,
    await fetchFile(config.clipB.file),
    'intercut write clip B',
  );

  const result = await generateIntercutFromVfs(
    ffmpeg,
    vfsNameA,
    vfsNameB,
    config,
    onStatus,
    outputName,
  );

  const output = await safeReadFile(ffmpeg, outputName, 'intercut read output');
  const plain = new Uint8Array(output).buffer as ArrayBuffer;

  for (const name of [vfsNameA, vfsNameB, outputName]) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }

  return {
    blob: new Blob([plain], { type: 'video/mp4' }),
    ...result,
  };
}
