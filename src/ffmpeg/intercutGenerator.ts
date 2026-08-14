import { fetchFile } from '@ffmpeg/util';
import { DEFAULT_EXPORT_SETTINGS, type Clip } from '../types';
import {
  clipHasSourceAudio,
  ensureFfmpeg,
  getSafeExtension,
  isNoAudioStreamError,
  isStillImageClip,
  safeExec,
  safeReadFile,
  safeWriteFile,
} from './core';
import {
  buildConcatPlaylist,
  buildIntercutSlices,
  canUseStreamCopyForIntercut,
  intercutOutputDuration,
  intercutShortageMessage,
  requestedIntercutDuration,
  type FrequencyAutomationConfig,
  type IntercutFinalClip,
  type IntercutSlice,
} from '../utils/intercut';
import { beatsInTrimWindow } from '../utils/beatMarkers';
import { resolveTargetResolution } from '../utils/resolution';
import type { IFfmpegRuntime } from './ffmpegRuntime';
import {
  emitProgress,
  type ProgressCallback,
  type StatusCallback,
} from './ffmpegCommon';

export type IntercutAudioPolicy = 'both' | 'aOnly' | 'silent';

export interface IntercutGeneratorConfig {
  clipA: Clip;
  clipB: Clip;
  automation: FrequencyAutomationConfig;
  /** When true, always re-encode (needed for strobe / short slices). */
  forceReencode?: boolean;
  /** Default `both` — A/B audio follows picture. */
  audioPolicy?: IntercutAudioPolicy;
  /** Snap slice lengths to the reference clip's beat grid when metadata exists. */
  snapCutsToBeats?: boolean;
  /** Which clip supplies `beatTimestamps`. Defaults to A, then B. */
  beatReference?: 'A' | 'B';
  /**
   * When true (default), throw if planned output is shorter than
   * `automation.totalDurationSec` plus `tailDurationSec`.
   */
  requireFullDuration?: boolean;
  /** Last swapping-phase slice. Default `auto` keeps A/B alternation. */
  forceFinalClip?: IntercutFinalClip;
  /** Extra seconds of the landing clip after the swapping phase. */
  tailDurationSec?: number;
}

export interface IntercutGeneratorResult {
  blob: Blob;
  slices: IntercutSlice[];
  usedStreamCopy: boolean;
  outputDurationSec: number;
  didNormalize: boolean;
}

export interface IntercutEstimate {
  slices: IntercutSlice[];
  sliceCount: number;
  outputDurationSec: number;
  usedStreamCopy: boolean;
  shortageMessage: string | null;
  needsNormalization: boolean;
}

function sourceBounds(clip: Clip): { trimStart: number; trimEnd: number } {
  return {
    trimStart: clip.trimStart,
    trimEnd: Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration,
  };
}

function beatSyncForConfig(config: IntercutGeneratorConfig) {
  if (!config.snapCutsToBeats) return undefined;
  const ref =
    config.beatReference === 'B'
      ? config.clipB
      : config.clipA.beatTimestamps?.length
        ? config.clipA
        : config.clipB.beatTimestamps?.length
          ? config.clipB
          : config.clipA;
  const beats = beatsInTrimWindow(ref);
  if (beats.length < 2) return undefined;
  return { beatTimestamps: beats };
}

export function planIntercutSlices(config: IntercutGeneratorConfig): IntercutSlice[] {
  return buildIntercutSlices({
    sourceA: sourceBounds(config.clipA),
    sourceB: sourceBounds(config.clipB),
    automation: config.automation,
    beatSync: beatSyncForConfig(config),
    forceFinalClip: config.forceFinalClip,
    tailDurationSec: config.tailDurationSec,
  });
}

/** True when A/B would concat-fail without a shared resolution/fps/codec. */
export function intercutNeedsNormalization(clipA: Clip, clipB: Clip): boolean {
  if (isStillImageClip(clipA) || isStillImageClip(clipB)) return true;

  const wA = clipA.videoWidth;
  const hA = clipA.videoHeight;
  const wB = clipB.videoWidth;
  const hB = clipB.videoHeight;
  if (wA && hA && wB && hB && (wA !== wB || hA !== hB)) return true;

  const fpsA = clipA.processedFps ?? clipA.originalFps;
  const fpsB = clipB.processedFps ?? clipB.originalFps;
  if (fpsA && fpsB && Math.abs(fpsA - fpsB) > 0.05) return true;

  const extA = getSafeExtension(clipA.file.name, 'mp4');
  const extB = getSafeExtension(clipB.file.name, 'mp4');
  if (extA !== extB) return true;

  const typeA = clipA.file.type;
  const typeB = clipB.file.type;
  if (typeA && typeB && typeA !== typeB) return true;

  // Concat requires a matching stream layout — video-only + A/V fails.
  if (clipHasSourceAudio(clipA) !== clipHasSourceAudio(clipB)) return true;

  return false;
}

export function estimateIntercut(config: IntercutGeneratorConfig): IntercutEstimate {
  const slices = planIntercutSlices(config);
  const shortageMessage = intercutShortageMessage(
    slices,
    requestedIntercutDuration(config.automation, config.tailDurationSec),
    sourceBounds(config.clipA),
    sourceBounds(config.clipB),
  );
  return {
    slices,
    sliceCount: slices.length,
    outputDurationSec: intercutOutputDuration(slices),
    usedStreamCopy:
      !config.forceReencode && canUseStreamCopyForIntercut(slices),
    shortageMessage,
    needsNormalization: intercutNeedsNormalization(config.clipA, config.clipB),
  };
}

export function buildIntercutConcatArgs(
  playlistName: string,
  outputName: string,
  useCopy: boolean,
  audioPolicy: IntercutAudioPolicy,
): string[] {
  const args: string[] = ['-f', 'concat', '-safe', '0', '-i', playlistName];
  if (useCopy) {
    if (audioPolicy === 'silent') {
      args.push('-c:v', 'copy', '-an', '-avoid_negative_ts', 'make_zero', outputName);
    } else {
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', outputName);
    }
    return args;
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
  );
  if (audioPolicy === 'silent') {
    args.push('-an', '-movflags', '+faststart', outputName);
  } else {
    args.push(
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
  return args;
}

export function buildNormalizeIntercutArgs(
  clip: Clip,
  inputName: string,
  outputName: string,
  width: number,
  height: number,
  options?: { hasAudio?: boolean },
): string[] {
  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
  const prefix = isStillImageClip(clip) ? ['-loop', '1'] : [];
  const encodeVideo = [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
  ];
  const encodeAudio = ['-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k'];
  const hasAudio = options?.hasAudio ?? clipHasSourceAudio(clip);

  if (hasAudio) {
    return [
      ...prefix,
      '-i',
      inputName,
      '-filter_complex',
      `[0:v]${vf}[vout];[0:a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[aout]`,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      ...encodeVideo,
      ...encodeAudio,
      '-movflags',
      '+faststart',
      outputName,
    ];
  }

  // Video-only / still: synthesize stereo silence so concat stream layouts match.
  return [
    ...prefix,
    '-i',
    inputName,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=stereo',
    '-filter_complex',
    `[0:v]${vf}[vout]`,
    '-map',
    '[vout]',
    '-map',
    '1:a',
    '-shortest',
    ...encodeVideo,
    ...encodeAudio,
    '-movflags',
    '+faststart',
    outputName,
  ];
}

export function buildReplaceAudioFromAArgs(
  concatName: string,
  clipAName: string,
  clipA: Clip,
  durationSec: number,
  outputName: string,
): string[] {
  return [
    '-i',
    concatName,
    '-ss',
    String(clipA.trimStart),
    '-t',
    String(durationSec),
    '-i',
    clipAName,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0?',
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

async function normalizeSourceIfNeeded(
  ffmpeg: IFfmpegRuntime,
  clip: Clip,
  inputName: string,
  outputName: string,
  width: number,
  height: number,
  onStatus: StatusCallback,
): Promise<string> {
  onStatus(`Intercut: normalizing "${clip.title}" to ${width}×${height} @ 30fps…`);
  const args = buildNormalizeIntercutArgs(clip, inputName, outputName, width, height);
  try {
    await safeExec(ffmpeg, args, null, `intercut normalize "${clip.title}"`);
  } catch (err) {
    if (!isNoAudioStreamError(err)) throw err;
    onStatus(`Clip "${clip.title}" has no audio — adding silence...`);
    const silentArgs = buildNormalizeIntercutArgs(
      clip,
      inputName,
      outputName,
      width,
      height,
      { hasAudio: false },
    );
    await safeExec(ffmpeg, silentArgs, null, `intercut normalize "${clip.title}" (silent)`);
  }
  return outputName;
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
  onProgress?: ProgressCallback,
): Promise<Omit<IntercutGeneratorResult, 'blob'>> {
  const slices = planIntercutSlices(config);
  const boundsA = sourceBounds(config.clipA);
  const boundsB = sourceBounds(config.clipB);
  const requireFull = config.requireFullDuration !== false;
  const shortage = intercutShortageMessage(
    slices,
    requestedIntercutDuration(config.automation, config.tailDurationSec),
    boundsA,
    boundsB,
  );
  if (slices.length === 0) {
    throw new Error(shortage ?? 'Intercut produced zero slices.');
  }
  if (requireFull && shortage) {
    throw new Error(shortage);
  }

  const audioPolicy: IntercutAudioPolicy = config.audioPolicy ?? 'both';
  let workA = vfsNameA;
  let workB = vfsNameB;
  let didNormalize = false;

  const normalizeBoth = async () => {
    didNormalize = true;
    const { width, height } = resolveTargetResolution(
      [config.clipA, config.clipB],
      DEFAULT_EXPORT_SETTINGS,
    );
    const normA = 'intercut-norm-a.mp4';
    const normB = 'intercut-norm-b.mp4';
    await deleteQuiet(ffmpeg, normA);
    await deleteQuiet(ffmpeg, normB);
    workA = await normalizeSourceIfNeeded(
      ffmpeg,
      config.clipA,
      vfsNameA,
      normA,
      width,
      height,
      onStatus,
    );
    workB = await normalizeSourceIfNeeded(
      ffmpeg,
      config.clipB,
      vfsNameB,
      normB,
      width,
      height,
      onStatus,
    );
  };

  if (intercutNeedsNormalization(config.clipA, config.clipB)) {
    await normalizeBoth();
  }

  const useCopy = !config.forceReencode && canUseStreamCopyForIntercut(slices);
  const playlistName = 'intercut_playlist.txt';
  const concatName = audioPolicy === 'aOnly' ? 'intercut_concat.mp4' : outputName;
  const outputDurationSec = intercutOutputDuration(slices);

  const runConcat = async () => {
    const playlist = buildConcatPlaylist(slices, workA, workB);
    await safeWriteFile(ffmpeg, playlistName, playlist, 'intercut concat playlist');
    onStatus(
      `Intercut: stitching ${slices.length} slice${slices.length === 1 ? '' : 's'} (${useCopy ? 'stream copy' : 're-encode'})…`,
    );
    emitProgress(onProgress, 'Intercut concat', 0.35, false);
    await safeExec(
      ffmpeg,
      buildIntercutConcatArgs(playlistName, concatName, useCopy, audioPolicy),
      {
        stage: 'Intercut concat',
        totalDuration: outputDurationSec,
        rangeStart: 0.35,
        rangeEnd: audioPolicy === 'aOnly' ? 0.8 : 0.95,
        onProgress,
      },
      `intercut generate (${slices.length} slices)`,
    );
  };

  try {
    await runConcat();
  } catch (err) {
    // Same-res video-only + A/V (or unknown hasAudio) can skip the first
    // normalize pass and then fail concat. Rebuild both sources with a
    // shared layout (including synthetic silence) and retry once.
    if (didNormalize) throw err;
    onStatus('Intercut: concat stream layout mismatch — normalizing sources…');
    await normalizeBoth();
    await runConcat();
  }

  if (audioPolicy === 'aOnly') {
    onStatus('Intercut: keeping audio from clip A…');
    await deleteQuiet(ffmpeg, outputName);
    try {
      await safeExec(
        ffmpeg,
        buildReplaceAudioFromAArgs(
          concatName,
          workA,
          config.clipA,
          outputDurationSec,
          outputName,
        ),
        null,
        'intercut replace audio from A',
      );
    } catch (err) {
      if (!isNoAudioStreamError(err)) throw err;
      onStatus('Intercut: clip A has no audio — writing silent output…');
      await safeExec(
        ffmpeg,
        ['-i', concatName, '-c:v', 'copy', '-an', '-movflags', '+faststart', outputName],
        null,
        'intercut silent fallback',
      );
    }
    await deleteQuiet(ffmpeg, concatName);
  }

  await deleteQuiet(ffmpeg, playlistName);
  if (didNormalize) {
    await deleteQuiet(ffmpeg, workA);
    await deleteQuiet(ffmpeg, workB);
  }

  emitProgress(onProgress, 'Intercut concat', 1, false);
  return { slices, usedStreamCopy: useCopy, outputDurationSec, didNormalize };
}

/**
 * End-to-end: write two clips to FFmpeg VFS, build dynamic intercut, return MP4 blob.
 */
export async function generateIntercutClip(
  config: IntercutGeneratorConfig,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<IntercutGeneratorResult> {
  if (config.clipA.id === config.clipB.id) {
    throw new Error('Pick two different clips for Intercut.');
  }
  if (config.clipA.kind !== 'video' || config.clipB.kind !== 'video') {
    throw new Error('Intercut requires two video clips.');
  }

  const ffmpeg = await ensureFfmpeg(onStatus);
  const extA = getSafeExtension(config.clipA.file.name, 'mp4');
  const extB = getSafeExtension(config.clipB.file.name, 'mp4');
  const vfsNameA = `intercut-a.${extA}`;
  const vfsNameB = `intercut-b.${extB}`;
  const outputName = 'intercut_output.mp4';

  for (const name of [vfsNameA, vfsNameB, outputName, 'intercut_concat.mp4']) {
    await deleteQuiet(ffmpeg, name);
  }

  onStatus('Preparing clips for intercut…');
  emitProgress(onProgress, 'Intercut prepare', 0.08, false);
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
    onProgress,
  );

  const output = await safeReadFile(ffmpeg, outputName, 'intercut read output');
  const plain = new Uint8Array(output).buffer as ArrayBuffer;

  for (const name of [vfsNameA, vfsNameB, outputName, 'intercut_concat.mp4']) {
    await deleteQuiet(ffmpeg, name);
  }

  return {
    blob: new Blob([plain], { type: 'video/mp4' }),
    ...result,
  };
}
