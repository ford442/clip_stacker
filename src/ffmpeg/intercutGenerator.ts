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
  type IntercutConsumeMode,
  type IntercutFinalClip,
  type IntercutSlot,
  type IntercutSlice,
  type IntercutSourceClock,
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
  /** Optional third clip; when set, slices cycle A → B → C. */
  clipC?: Clip;
  automation: FrequencyAutomationConfig;
  /** When true, always re-encode (needed for strobe / short slices). */
  forceReencode?: boolean;
  /** Default `both` — A/B audio follows picture. */
  audioPolicy?: IntercutAudioPolicy;
  /** Snap slice lengths to the reference clip's beat grid when metadata exists. */
  snapCutsToBeats?: boolean;
  /** Which clip supplies `beatTimestamps`. Defaults to A, then B, then C. */
  beatReference?: IntercutSlot;
  /**
   * When true (default), throw if planned output is shorter than
   * `automation.totalDurationSec` plus `tailDurationSec`.
   */
  requireFullDuration?: boolean;
  /** Last swapping-phase slice. Default `auto` keeps A/B/C cycling. */
  forceFinalClip?: IntercutFinalClip;
  /** Extra seconds of the landing clip after the swapping phase. */
  tailDurationSec?: number;
  /**
   * `targetDuration` (default) fills the swap duration; `entireSources`
   * keeps cutting until the material budget for `sourceClock` is drained.
   */
  consumeMode?: IntercutConsumeMode;
  /**
   * `freezeHidden` (default) pauses the offscreen clip; `parallel` advances
   * both playheads with output wall time.
   */
  sourceClock?: IntercutSourceClock;
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

function intercutSourceClips(config: IntercutGeneratorConfig): Clip[] {
  return config.clipC ? [config.clipA, config.clipB, config.clipC] : [config.clipA, config.clipB];
}

function beatSyncForConfig(config: IntercutGeneratorConfig) {
  if (!config.snapCutsToBeats) return undefined;
  const clips = intercutSourceClips(config);
  const bySlot: Record<IntercutSlot, Clip | undefined> = {
    A: config.clipA,
    B: config.clipB,
    C: config.clipC,
  };
  const preferred = config.beatReference ? bySlot[config.beatReference] : undefined;
  const order = preferred ? [preferred, ...clips.filter((c) => c.id !== preferred.id)] : clips;
  const ref = order.find((c) => (c.beatTimestamps?.length ?? 0) >= 2) ?? order[0]!;
  const beats = beatsInTrimWindow(ref);
  if (beats.length < 2) return undefined;
  return { beatTimestamps: beats };
}

export function planIntercutSlices(config: IntercutGeneratorConfig): IntercutSlice[] {
  return buildIntercutSlices({
    sourceA: sourceBounds(config.clipA),
    sourceB: sourceBounds(config.clipB),
    sourceC: config.clipC ? sourceBounds(config.clipC) : undefined,
    automation: config.automation,
    beatSync: beatSyncForConfig(config),
    forceFinalClip: config.forceFinalClip,
    tailDurationSec: config.tailDurationSec,
    consumeMode: config.consumeMode,
    sourceClock: config.sourceClock,
  });
}

function clipsNeedNormalizationPair(clipA: Clip, clipB: Clip): boolean {
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

/** True when sources would concat-fail without a shared resolution/fps/codec. */
export function intercutNeedsNormalization(clipA: Clip, clipB: Clip, clipC?: Clip): boolean {
  if (clipsNeedNormalizationPair(clipA, clipB)) return true;
  if (clipC && (clipsNeedNormalizationPair(clipA, clipC) || clipsNeedNormalizationPair(clipB, clipC))) {
    return true;
  }
  return false;
}

export function estimateIntercut(config: IntercutGeneratorConfig): IntercutEstimate {
  const slices = planIntercutSlices(config);
  const boundsA = sourceBounds(config.clipA);
  const boundsB = sourceBounds(config.clipB);
  const boundsC = config.clipC ? sourceBounds(config.clipC) : undefined;
  const consumeMode = config.consumeMode ?? 'targetDuration';
  const sourceClock = config.sourceClock ?? 'freezeHidden';
  const shortageMessage = intercutShortageMessage(
    slices,
    requestedIntercutDuration(config.automation, config.tailDurationSec, {
      consumeMode,
      sourceClock,
      sourceA: boundsA,
      sourceB: boundsB,
      sourceC: boundsC,
    }),
    boundsA,
    boundsB,
    consumeMode,
    sourceClock,
    boundsC,
  );
  return {
    slices,
    sliceCount: slices.length,
    outputDurationSec: intercutOutputDuration(slices),
    // Generation always re-encodes; stream-copy of alternating inpoints is unsafe.
    usedStreamCopy: false,
    shortageMessage,
    needsNormalization: intercutNeedsNormalization(config.clipA, config.clipB, config.clipC),
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
 * Generate an intercut MP4 from clips already written to the FFmpeg VFS.
 */
export async function generateIntercutFromVfs(
  ffmpeg: IFfmpegRuntime,
  vfsNameA: string,
  vfsNameB: string,
  config: IntercutGeneratorConfig,
  onStatus: StatusCallback,
  outputName = 'intercut_output.mp4',
  onProgress?: ProgressCallback,
  vfsNameC?: string,
): Promise<Omit<IntercutGeneratorResult, 'blob'>> {
  const slices = planIntercutSlices(config);
  const boundsA = sourceBounds(config.clipA);
  const boundsB = sourceBounds(config.clipB);
  const boundsC = config.clipC ? sourceBounds(config.clipC) : undefined;
  const consumeMode = config.consumeMode ?? 'targetDuration';
  const sourceClock = config.sourceClock ?? 'freezeHidden';
  const requireFull = config.requireFullDuration !== false;
  const shortage = intercutShortageMessage(
    slices,
    requestedIntercutDuration(config.automation, config.tailDurationSec, {
      consumeMode,
      sourceClock,
      sourceA: boundsA,
      sourceB: boundsB,
      sourceC: boundsC,
    }),
    boundsA,
    boundsB,
    consumeMode,
    sourceClock,
    boundsC,
  );
  if (slices.length === 0) {
    throw new Error(shortage ?? 'Intercut produced zero slices.');
  }
  if (requireFull && shortage) {
    throw new Error(shortage);
  }
  if (config.clipC && !vfsNameC) {
    throw new Error('Intercut clip C is missing from the FFmpeg VFS.');
  }

  const audioPolicy: IntercutAudioPolicy = config.audioPolicy ?? 'both';
  if (audioPolicy === 'silent') {
    await ensureSilentAacUnit(ffmpeg, onStatus);
  }
  let workA = vfsNameA;
  let workB = vfsNameB;
  let workC = vfsNameC;
  let didNormalize = false;
  // After trim-window normalize, playlist times are relative to each trimStart.
  let concatSlices = slices;

  const normalizeSources = async () => {
    didNormalize = true;
    const { width, height } = resolveTargetResolution(
      intercutSourceClips(config),
      DEFAULT_EXPORT_SETTINGS,
    );
    const normA = 'intercut-norm-a.mp4';
    const normB = 'intercut-norm-b.mp4';
    const normC = 'intercut-norm-c.mp4';
    await deleteQuiet(ffmpeg, normA);
    await deleteQuiet(ffmpeg, normB);
    await deleteQuiet(ffmpeg, normC);
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
    if (config.clipC && vfsNameC && boundsC) {
      const windowC = {
        seekSec: boundsC.trimStart,
        durationSec: Math.max(0.05, boundsC.trimEnd - boundsC.trimStart),
      };
      workC = await normalizeSourceIfNeeded(
        ffmpeg,
        config.clipC,
        vfsNameC,
        normC,
        width,
        height,
        onStatus,
        windowC,
      );
    }
    concatSlices = remapIntercutSlicesToTrimOrigin(
      slices,
      boundsA.trimStart,
      boundsB.trimStart,
      boundsC?.trimStart ?? 0,
    );
  };

  if (intercutNeedsNormalization(config.clipA, config.clipB, config.clipC)) {
    await normalizeSources();
  }

  // Always re-encode: stream-copy of multi-source inpoint cuts is rarely
  // keyframe-aligned and often yields MP4s browsers cannot open.
  const useCopy = false;
  const playlistName = 'intercut_playlist.txt';
  const concatName = audioPolicy === 'aOnly' ? 'intercut_concat.mp4' : outputName;
  const outputDurationSec = intercutOutputDuration(slices);

  const runConcat = async () => {
    const playlist = buildConcatPlaylist(concatSlices, workA, workB, workC);
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
    // normalize pass and then fail concat. Rebuild sources with a
    // shared layout (including synthetic silence) and retry once.
    if (didNormalize) throw err;
    onStatus('Intercut: concat failed — normalizing sources and retrying…');
    await normalizeSources();
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
    if (workC) await deleteQuiet(ffmpeg, workC);
  }

  emitProgress(onProgress, 'Intercut concat', 1, false);
  return { slices, usedStreamCopy: useCopy, outputDurationSec, didNormalize };
}

/**
 * End-to-end: write clips to FFmpeg VFS, build dynamic intercut, return MP4 blob.
 */
export async function generateIntercutClip(
  config: IntercutGeneratorConfig,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<IntercutGeneratorResult> {
  const ids = [config.clipA.id, config.clipB.id, config.clipC?.id].filter(
    (id): id is string => !!id,
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error('Pick different clips for Intercut.');
  }
  const kindsOk =
    config.clipA.kind === 'video' &&
    config.clipB.kind === 'video' &&
    (!config.clipC || config.clipC.kind === 'video');
  if (!kindsOk) {
    throw new Error('Intercut requires video clips.');
  }

  const ffmpeg = await ensureFfmpeg(onStatus);
  const extA = getSafeExtension(config.clipA.file.name, 'mp4');
  const extB = getSafeExtension(config.clipB.file.name, 'mp4');
  const vfsNameA = `intercut-a.${extA}`;
  const vfsNameB = `intercut-b.${extB}`;
  const vfsNameC = config.clipC
    ? `intercut-c.${getSafeExtension(config.clipC.file.name, 'mp4')}`
    : undefined;
  const outputName = 'intercut_output.mp4';

  const vfsNames = [vfsNameA, vfsNameB, vfsNameC, outputName, 'intercut_concat.mp4'].filter(
    (n): n is string => !!n,
  );
  for (const name of vfsNames) {
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
  if (config.clipC && vfsNameC) {
    await safeWriteFile(
      ffmpeg,
      vfsNameC,
      await fetchFile(config.clipC.file),
      'intercut write clip C',
    );
  }

  const result = await generateIntercutFromVfs(
    ffmpeg,
    vfsNameA,
    vfsNameB,
    config,
    onStatus,
    outputName,
    onProgress,
    vfsNameC,
  );

  const output = await safeReadFile(ffmpeg, outputName, 'intercut read output');
  if (!(output instanceof Uint8Array) || output.byteLength < 32) {
    throw new Error(
      `Intercut produced an empty or invalid MP4 (${output instanceof Uint8Array ? output.byteLength : 0} bytes).`,
    );
  }
  // Copy into a standalone buffer — WASM may return a HEAP subarray view.
  const plain = output.slice().buffer as ArrayBuffer;

  for (const name of vfsNames) {
    await deleteQuiet(ffmpeg, name);
  }

  return {
    blob: new Blob([plain], { type: 'video/mp4' }),
    ...result,
  };
}
