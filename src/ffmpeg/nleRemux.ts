/**
 * Cheap FFmpeg remux so GPU-stitch / intercut MP4s import into Steinberg NLEs.
 *
 * Video is stream-copied (WASM re-encode of a long stitch is too expensive).
 * Audio is kept when present; otherwise a looped silent AAC unit is muxed.
 * Always writes a leading moov via +faststart.
 */

import {
  ensureFfmpeg,
  isNoAudioStreamError,
  safeExec,
  safeReadFile,
  safeWriteFile,
  type ProgressCallback,
  type StatusCallback,
} from './core';
import type { IFfmpegRuntime } from './ffmpegRuntime';
import {
  SILENT_AAC_UNIT_NAME,
  buildSilentAacLoopInputArgs,
  ensureSilentAacUnit,
} from './silentAudio';

export const NLE_VIDEO_TIMESCALE = 30_000;
export const GPU_STITCH_RAW_NAME = 'gpu_stitch_raw.mp4';
export const GPU_STITCH_NLE_NAME = 'gpu_stitch_nle.mp4';

/** Remux existing video + audio; optional audio map so missing tracks fail cleanly. */
export function buildPreserveAudioNleRemuxArgs(
  inputName: string,
  outputName: string,
): string[] {
  return [
    '-i',
    inputName,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-b:a',
    '192k',
    '-shortest',
    '-movflags',
    '+faststart',
    '-video_track_timescale',
    String(NLE_VIDEO_TIMESCALE),
    outputName,
  ];
}

/** Video stream-copy + looped silent AAC (caller must ensureSilentAacUnit). */
export function buildSilentAudioNleRemuxArgs(
  inputName: string,
  outputName: string,
  silentUnitName: string = SILENT_AAC_UNIT_NAME,
): string[] {
  return [
    '-i',
    inputName,
    ...buildSilentAacLoopInputArgs(silentUnitName),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-shortest',
    '-movflags',
    '+faststart',
    '-video_track_timescale',
    String(NLE_VIDEO_TIMESCALE),
    outputName,
  ];
}

async function deleteQuiet(ffmpeg: IFfmpegRuntime, name: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    /* ignore */
  }
}

/**
 * Remux a Space-stitched MP4 for Cubase/Nuendo: leading moov, stereo AAC,
 * shared video timescale. Does not re-encode video.
 */
export async function remuxStitchedMp4ForNle(
  blob: Blob,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const ffmpeg = await ensureFfmpeg(onStatus, onProgress);
  await deleteQuiet(ffmpeg, GPU_STITCH_RAW_NAME);
  await deleteQuiet(ffmpeg, GPU_STITCH_NLE_NAME);

  onStatus('Making the stitched MP4 editor-compatible…');
  await safeWriteFile(
    ffmpeg,
    GPU_STITCH_RAW_NAME,
    new Uint8Array(await blob.arrayBuffer()),
    'nle remux write stitch',
  );

  try {
    try {
      await safeExec(
        ffmpeg,
        buildPreserveAudioNleRemuxArgs(GPU_STITCH_RAW_NAME, GPU_STITCH_NLE_NAME),
        null,
        'nle remux preserve audio',
      );
    } catch (err) {
      if (!isNoAudioStreamError(err)) throw err;
      onStatus('Stitched video has no audio — muxing a silent AAC track…');
      await ensureSilentAacUnit(ffmpeg, onStatus);
      await deleteQuiet(ffmpeg, GPU_STITCH_NLE_NAME);
      await safeExec(
        ffmpeg,
        buildSilentAudioNleRemuxArgs(GPU_STITCH_RAW_NAME, GPU_STITCH_NLE_NAME),
        null,
        'nle remux silent audio',
      );
    }

    const output = await safeReadFile(
      ffmpeg,
      GPU_STITCH_NLE_NAME,
      'nle remux read output',
    );
    const bytes = output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer);
    if (bytes.byteLength < 32) {
      throw new Error(
        `Editor remux produced an empty or invalid MP4 (${bytes.byteLength} bytes).`,
      );
    }
    const plain = bytes.slice().buffer as ArrayBuffer;
    return new Blob([plain], { type: 'video/mp4' });
  } finally {
    await deleteQuiet(ffmpeg, GPU_STITCH_RAW_NAME);
    await deleteQuiet(ffmpeg, GPU_STITCH_NLE_NAME);
  }
}
