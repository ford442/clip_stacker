import type { ExportSettings } from '../types';
import {
  emitProgress,
  ensureFfmpeg,
  safeExec,
  safeReadFile,
  safeWriteFile,
  type ProgressCallback,
  type StatusCallback,
} from './core';

const INPUT_NAME = 'render-finalizer-input.mp4';

export function needsExportFinalization(settings: ExportSettings): boolean {
  return (
    settings.outputFormat === 'prores' ||
    Boolean(settings.lightVideoCleanup) ||
    Boolean(settings.audioCleanup)
  );
}

export function buildExportFinalizeArgs(settings: ExportSettings): string[] {
  const isProRes = settings.outputFormat === 'prores';
  const outputName = isProRes ? 'render-finalized.mov' : 'render-finalized.mp4';
  const args = ['-i', INPUT_NAME, '-map', '0:v:0', '-map', '0:a?'];

  if (settings.lightVideoCleanup) {
    args.push('-vf', 'hqdn3d=1.2:1.2:3:3,deband=1thr=0.02:2thr=0.02:3thr=0.02:4thr=0.02');
  }
  if (settings.audioCleanup) {
    args.push('-af', 'highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11');
  }

  if (isProRes) {
    const profile = [1, 2, 3].includes(settings.proresProfile ?? 3)
      ? settings.proresProfile ?? 3
      : 3;
    args.push(
      '-c:v', 'prores_ks',
      '-profile:v', String(profile),
      '-pix_fmt', 'yuv422p10le',
      '-vendor', 'apl0',
      '-c:a', settings.audioCleanup ? 'pcm_s16le' : 'copy',
      '-movflags', '+faststart',
      '-f', 'mov',
      '-y', outputName,
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-crf', String(settings.crf),
      '-preset', settings.preset,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', outputName,
    );
  }
  return args;
}

export async function finalizeRenderedVideo(
  blob: Blob,
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (!needsExportFinalization(settings)) return blob;

  const isProRes = settings.outputFormat === 'prores';
  const outputName = isProRes ? 'render-finalized.mov' : 'render-finalized.mp4';
  const mimeType = isProRes ? 'video/quicktime' : 'video/mp4';
  const ffmpeg = await ensureFfmpeg(onStatus, onProgress);
  onStatus(isProRes ? 'Encoding final ProRes MOV…' : 'Applying final export cleanup…');
  emitProgress(onProgress, 'Final output encode', 0.01, false);

  try {
    await safeWriteFile(
      ffmpeg,
      INPUT_NAME,
      new Uint8Array(await blob.arrayBuffer()),
      'write final render input',
    );
    await safeExec(ffmpeg, buildExportFinalizeArgs(settings), null, 'Final output encode');
    const output = await safeReadFile(ffmpeg, outputName, 'final output read');
    const plain = new Uint8Array(output).buffer as ArrayBuffer;
    emitProgress(onProgress, 'Final output encode', 1, false);
    return new Blob([plain], { type: mimeType });
  } finally {
    for (const name of [INPUT_NAME, outputName]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        // Ignore missing files during cleanup.
      }
    }
  }
}
