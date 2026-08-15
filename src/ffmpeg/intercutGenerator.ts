import { fetchFile } from '@ffmpeg/util';
import { DEFAULT_EXPORT_SETTINGS, type Clip } from '../types';
import {
  buildSilentAacLoopInputArgs,
  clipHasSourceAudio,
  ensureFfmpeg,
  ensureSilentAacUnit,
  getSafeExtension,
  isNoAudioStreamError,
  isStillImageClip,
  safeExec,
  safeReadFile,
  safeWriteFile,
} from './core';
import { buildSilentAudioNleRemuxArgs } from './nleRemux';
import {
  buildConcatPlaylist,
  buildIntercutSlices,
  intercutOutputDuration,
  intercutShortageMessage,
  remapIntercutSlicesToTrimOrigin,
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
    // Generation always re-encodes; stream-copy of alternating inpoints is unsafe.
    usedStreamCopy: false,
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
  // +genpts rebuilds timestamps after concat inpoint/outpoint seeks.
  const args: string[] = [
    '-f',
    'concat',
    '-safe',
    '0',
    '-fflags',
    '+genpts',
    '-i',
    playlistName,
  ];
  if (audioPolicy === 'silent') {
    args.push(...buildSilentAacLoopInputArgs());
  }
  if (useCopy) {
    if (audioPolicy === 'silent') {
      args.push(
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        '-shortest',
        '-avoid_negative_ts',
        'make_zero',
        '-movflags',
        '+faststart',
        outputName,
      );
    } else {
      args.push(
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        '-movflags',
        '+faststart',
        outputName,
      );
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
    '-r',
    '30',
    '-vsync',
    'cfr',
    '-bf',
    '0',
  );
  if (audioPolicy === 'silent') {
    args.push(
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:a',
      'copy',
      '-shortest',
      '-movflags',
      '+faststart',
      outputName,
    );
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

export interface NormalizeIntercutOptions {
  hasAudio?: boolean;
  /** Input seek (seconds). Prefer seeking before decode to avoid full-file re-encodes. */
  seekSec?: number;
  /** Max output duration (seconds) after seek. */
  durationSec?: number;
}

export function buildNormalizeIntercutArgs(
  clip: Clip,
  inputName: string,
  outputName: string,
  width: number,
  height: number,
  options?: NormalizeIntercutOptions,
): string[] {
  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
  const seekSec = options?.seekSec;
  const durationSec = options?.durationSec;
  const seekArgs =
    typeof seekSec === 'number' && Number.isFinite(seekSec) && seekSec > 0
      ? (['-ss', String(seekSec)] as string[])
      : [];
  const durationArgs =
    typeof durationSec === 'number' &&
    Number.isFinite(durationSec) &&
    durationSec > 0
      ? (['-t', String(durationSec)] as string[])
      : [];
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
      ...seekArgs,
      ...prefix,
      '-i',
      inputName,
      ...durationArgs,
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

  // Video-only / still: loop pre-encoded silent AAC (caller must ensureSilentAacUnit).
  return [
    ...seekArgs,
    ...prefix,
    '-i',
    inputName,
    ...durationArgs,
    ...buildSilentAacLoopInputArgs(),
    '-filter_complex',
    `[0:v]${vf}[vout]`,
    '-map',
    '[vout]',
    '-map',
    '1:a',
    '-shortest',
    ...encodeVideo,
    '-c:a',
    'copy',
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
  options?: { audioSeekSec?: number },
): string[] {
  // When A was trim-window normalized, audio already starts at 0.
  const audioSeek =
    options?.audioSeekSec ??
    (Number.isFinite(clipA.trimStart) ? clipA.trimStart : 0);
  return [
    '-i',
    concatName,
    '-ss',
    String(Math.max(0, audioSeek)),
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
  window?: { seekSec: number; durationSec: number },
): Promise<string> {
  const rangeLabel =
    window && window.durationSec > 0
      ? ` (trim ${window.seekSec.toFixed(2)}s…${(window.seekSec + window.durationSec).toFixed(2)}s)`
      : '';
  onStatus(
    `Intercut: normalizing "${clip.title}" to ${width}×${height} @ 30fps${rangeLabel}…`,
  );
  const windowOpts: NormalizeIntercutOptions | undefined = window
    ? { seekSec: window.seekSec, durationSec: window.durationSec }
    : undefined;
  const knownSilent = !clipHasSourceAudio(clip);
  if (knownSilent) {
    await ensureSilentAacUnit(ffmpeg, onStatus);
  }
  const args = buildNormalizeIntercutArgs(
    clip,
    inputName,
    outputName,
    width,
    height,
    windowOpts,
  );
  try {
    await safeExec(ffmpeg, args, null, `intercut normalize "${clip.title}"`);
  } catch (err) {
    if (!isNoAudioStreamError(err)) throw err;
    onStatus(
      `Clip "${clip.title}" has no audio — muxing silent track (stream copy)…`,
    );
    await ensureSilentAacUnit(ffmpeg, onStatus);
    const silentArgs = buildNormalizeIntercutArgs(
      clip,
      inputName,
      outputName,
      width,
      height,
      { ...windowOpts, hasAudio: false },
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
  if (audioPolicy === 'silent') {
    await ensureSilentAacUnit(ffmpeg, onStatus);
  }
  let workA = vfsNameA;
  let workB = vfsNameB;
  let didNormalize = false;
  // After trim-window normalize, playlist times are relative to each trimStart.
  let concatSlices = slices;

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
    // Only re-encode the trimmed windows — full-file normalize OOMs WASM on long clips.
    const windowA = {
      seekSec: boundsA.trimStart,
      durationSec: Math.max(0.05, boundsA.trimEnd - boundsA.trimStart),
    };
    const windowB = {
      seekSec: boundsB.trimStart,
      durationSec: Math.max(0.05, boundsB.trimEnd - boundsB.trimStart),
    };
    workA = await normalizeSourceIfNeeded(
      ffmpeg,
      config.clipA,
      vfsNameA,
      normA,
      width,
      height,
      onStatus,
      windowA,
    );
    workB = await normalizeSourceIfNeeded(
      ffmpeg,
      config.clipB,
      vfsNameB,
      normB,
      width,
      height,
      onStatus,
      windowB,
    );
    concatSlices = remapIntercutSlicesToTrimOrigin(
      slices,
      boundsA.trimStart,
      boundsB.trimStart,
    );
  };

  if (intercutNeedsNormalization(config.clipA, config.clipB)) {
    await normalizeBoth();
  }

  // Always re-encode: stream-copy of multi-source inpoint cuts is rarely
  // keyframe-aligned and often yields MP4s browsers cannot open.
  const useCopy = false;
  const playlistName = 'intercut_playlist.txt';
  const concatName = audioPolicy === 'aOnly' ? 'intercut_concat.mp4' : outputName;
  const outputDurationSec = intercutOutputDuration(slices);

  const runConcat = async () => {
    const playlist = buildConcatPlaylist(concatSlices, workA, workB);
    await safeWriteFile(ffmpeg, playlistName, playlist, 'intercut concat playlist');
    onStatus(
      `Intercut: stitching ${concatSlices.length} slice${concatSlices.length === 1 ? '' : 's'} (re-encode)…`,
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
      `intercut generate (${concatSlices.length} slices)`,
    );
  };

  try {
    await runConcat();
  } catch (err) {
    // Same-res video-only + A/V (or unknown hasAudio) can skip the first
    // normalize pass and then fail concat. Rebuild both sources with a
    // shared layout (including synthetic silence) and retry once.
    if (didNormalize) throw err;
    onStatus('Intercut: concat failed — normalizing sources and retrying…');
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
          // Normalized workA is already cropped to trimStart.
          { audioSeekSec: didNormalize ? 0 : config.clipA.trimStart },
        ),
        null,
        'intercut replace audio from A',
      );
    } catch (err) {
      if (!isNoAudioStreamError(err)) throw err;
      onStatus('Intercut: clip A has no audio — muxing a silent AAC track…');
      await ensureSilentAacUnit(ffmpeg, onStatus);
      await safeExec(
        ffmpeg,
        buildSilentAudioNleRemuxArgs(concatName, outputName),
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
  if (!(output instanceof Uint8Array) || output.byteLength < 32) {
    throw new Error(
      `Intercut produced an empty or invalid MP4 (${output instanceof Uint8Array ? output.byteLength : 0} bytes).`,
    );
  }
  // Copy into a standalone buffer — WASM may return a HEAP subarray view.
  const plain = output.slice().buffer as ArrayBuffer;

  for (const name of [vfsNameA, vfsNameB, outputName, 'intercut_concat.mp4']) {
    await deleteQuiet(ffmpeg, name);
  }

  return {
    blob: new Blob([plain], { type: 'video/mp4' }),
    ...result,
  };
}
