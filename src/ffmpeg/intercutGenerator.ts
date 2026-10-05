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
import {
  assembleIntercutAudio,
  buildIntercutVideoFilterGraph,
  encodeWavPcm16,
  INTERCUT_AUDIO_CHANNELS,
  INTERCUT_AUDIO_SAMPLE_RATE,
  INTERCUT_OUTPUT_FPS,
  mixSteadyStreams,
  parseWavPcm16,
  quantizeIntercutSlices,
  steadyStreamPcm,
  toStereo,
  type IntercutFramePlan,
  type IntercutFrameSlice,
} from '../utils/intercutRender';
import { beatsInTrimWindow } from '../utils/beatMarkers';
import { resolveTargetResolution } from '../utils/resolution';
import type { IFfmpegRuntime } from './ffmpegRuntime';
import {
  emitProgress,
  type ProgressCallback,
  type StatusCallback,
} from './ffmpegCommon';

export type IntercutAudioPolicy = 'both' | 'aOnly' | 'silent' | 'steadyStreams';

export interface IntercutGeneratorConfig {
  clipA: Clip;
  clipB: Clip;
  /** Optional third clip; when set, slices cycle A → B → C. */
  clipC?: Clip;
  automation: FrequencyAutomationConfig;
  /** When true, always re-encode (needed for strobe / short slices). */
  forceReencode?: boolean;
  /**
   * Default `both` — audio follows picture.
   * `steadyStreams` keeps every source's audio running from its trim start
   * for the whole output, muxed as its own AAC track (plus an equal-power mix
   * as the default track so the library player hears all beds).
   */
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

function secondsArg(sec: number): string {
  return String(Number(sec.toFixed(6)));
}

/**
 * Input args for one intercut source. Video seeks to its trim start so the
 * source's frame 0 (after `fps`) is the trim origin the frame plan counts from;
 * stills loop at the output rate.
 */
export function buildIntercutSourceInputArgs(
  clip: Clip,
  inputName: string,
  trimStart: number,
  durationSec: number,
): string[] {
  const duration = ['-t', secondsArg(Math.max(1 / INTERCUT_OUTPUT_FPS, durationSec))];
  if (isStillImageClip(clip)) {
    return ['-loop', '1', '-framerate', String(INTERCUT_OUTPUT_FPS), ...duration, '-i', inputName];
  }
  const seek = trimStart > 0 ? ['-ss', secondsArg(trimStart)] : [];
  return [...seek, ...duration, '-i', inputName];
}

/**
 * Decode one source's audio (from its trim start) to 16-bit stereo PCM.
 * `aresample=async=1:first_pts=0` pads a late-starting or gappy stream so
 * sample N is always source time trimStart + N / 44100.
 */
export function buildIntercutAudioExtractArgs(
  inputName: string,
  outputName: string,
  trimStart: number,
  durationSec: number,
): string[] {
  const seek = trimStart > 0 ? ['-ss', secondsArg(trimStart)] : [];
  return [
    ...seek,
    '-t',
    secondsArg(durationSec),
    '-i',
    inputName,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    `aresample=${INTERCUT_AUDIO_SAMPLE_RATE}:async=1:first_pts=0`,
    '-ac',
    String(INTERCUT_AUDIO_CHANNELS),
    '-ar',
    String(INTERCUT_AUDIO_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    outputName,
  ];
}

export interface IntercutAudioTrackInput {
  name: string;
  /** Stream title written into the MP4 (`metadata:s:a:N title=`). */
  title: string;
}

export interface IntercutRenderArgsOptions {
  /** Per-source input args, in input-index order (see `buildIntercutSourceInputArgs`). */
  sourceInputs: string[][];
  /** Pre-spliced PCM soundtrack (last input) when `audioTracks` is omitted. */
  audioName?: string;
  /**
   * Continuous beds muxed as separate AAC streams. The first track is the
   * default (what the library player plays). Used by `steadyStreams`.
   */
  audioTracks?: IntercutAudioTrackInput[];
  filterGraph: string;
  totalFrames: number;
  outputName: string;
}

/**
 * Single encode: the frame-grid video graph plus one or more WAVs that are
 * exactly `totalFrames` long, so nothing is left for the muxer to guess.
 */
export function buildIntercutRenderArgs(options: IntercutRenderArgsOptions): string[] {
  const tracks = options.audioTracks?.length
    ? options.audioTracks
    : [{ name: options.audioName ?? 'intercut-audio.wav', title: 'Audio' }];
  const firstAudioIndex = options.sourceInputs.length;
  const audioArgs: string[] = [];
  tracks.forEach((track, i) => {
    audioArgs.push('-map', `${firstAudioIndex + i}:a:0`);
    audioArgs.push(`-metadata:s:a:${i}`, `title=${track.title}`);
    audioArgs.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');
  });
  return [
    ...options.sourceInputs.flat(),
    ...tracks.flatMap((track) => ['-i', track.name]),
    '-filter_complex',
    options.filterGraph,
    '-map',
    '[vout]',
    ...audioArgs,
    '-frames:v',
    String(options.totalFrames),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(INTERCUT_OUTPUT_FPS),
    '-vsync',
    'cfr',
    '-bf',
    '0',
    '-c:a',
    'aac',
    '-ar',
    String(INTERCUT_AUDIO_SAMPLE_RATE),
    '-ac',
    String(INTERCUT_AUDIO_CHANNELS),
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    options.outputName,
  ];
}

/** Which source supplies each output frame's sound under `policy`. */
export function intercutAudioSlices(
  policy: IntercutAudioPolicy,
  plan: IntercutFramePlan,
): IntercutFrameSlice[] {
  if (policy === 'silent' || policy === 'steadyStreams') return [];
  if (policy === 'aOnly') {
    // A's soundtrack runs continuously from its trim start, whatever is on screen.
    return [{ slot: 'A', sourceFrame: 0, outputFrame: 0, frameCount: plan.totalFrames }];
  }
  return plan.slices;
}

/** Frames of `slot` a plan reads, from the trim origin (plus the crossfade tail). */
function framesNeeded(slices: IntercutFrameSlice[], slot: IntercutSlot): number {
  return slices
    .filter((s) => s.slot === slot)
    .reduce((max, s) => Math.max(max, s.sourceFrame + s.frameCount), 0);
}

async function deleteQuiet(ffmpeg: IFfmpegRuntime, name: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    /* ignore */
  }
}

interface IntercutSource {
  slot: IntercutSlot;
  clip: Clip;
  vfsName: string;
  trimStart: number;
}

/** Decode one source's audio to PCM; `undefined` (silence) when it has none. */
async function extractSourcePcm(
  ffmpeg: IFfmpegRuntime,
  source: IntercutSource,
  durationSec: number,
  onStatus: StatusCallback,
): Promise<Int16Array | undefined> {
  if (!clipHasSourceAudio(source.clip)) return undefined;
  const wavName = `intercut-pcm-${source.slot.toLowerCase()}.wav`;
  await deleteQuiet(ffmpeg, wavName);
  try {
    await safeExec(
      ffmpeg,
      buildIntercutAudioExtractArgs(source.vfsName, wavName, source.trimStart, durationSec),
      null,
      `intercut decode audio "${source.clip.title}"`,
    );
  } catch (err) {
    if (!isNoAudioStreamError(err)) throw err;
    onStatus(`Intercut: "${source.clip.title}" has no audio — using silence for its slices.`);
    return undefined;
  }
  try {
    const pcm = parseWavPcm16(await safeReadFile(ffmpeg, wavName, 'intercut read audio'));
    if (pcm.sampleRate !== INTERCUT_AUDIO_SAMPLE_RATE) {
      throw new Error(
        `Intercut audio: decoded "${source.clip.title}" at ${pcm.sampleRate} Hz, expected ${INTERCUT_AUDIO_SAMPLE_RATE}.`,
      );
    }
    return toStereo(pcm);
  } finally {
    await deleteQuiet(ffmpeg, wavName);
  }
}

/**
 * Generate an intercut MP4 from clips already written to the FFmpeg VFS.
 *
 * Slices are snapped to a 30 fps grid (`quantizeIntercutSlices`); picture is
 * cut by one filter graph and sound is spliced sample-exactly in JS from the
 * same grid, then both are encoded in one pass. The concat demuxer is not
 * used: its packet-granular `inpoint` dragged pre-roll video and AAC priming
 * into every cut, which stacked audio packets on the cut timestamps.
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
  const plan = quantizeIntercutSlices(
    remapIntercutSlicesToTrimOrigin(
      slices,
      boundsA.trimStart,
      boundsB.trimStart,
      boundsC?.trimStart ?? 0,
    ),
  );
  if (plan.totalFrames === 0) {
    throw new Error('Intercut slices are shorter than one frame.');
  }
  const outputDurationSec = plan.totalFrames / INTERCUT_OUTPUT_FPS;

  const sources: IntercutSource[] = [
    { slot: 'A', clip: config.clipA, vfsName: vfsNameA, trimStart: boundsA.trimStart },
    { slot: 'B', clip: config.clipB, vfsName: vfsNameB, trimStart: boundsB.trimStart },
  ];
  if (config.clipC && vfsNameC && boundsC) {
    sources.push({ slot: 'C', clip: config.clipC, vfsName: vfsNameC, trimStart: boundsC.trimStart });
  }

  // Sound first: decode each audible source once. Picture-following policies
  // splice on the frame grid; steadyStreams keeps each bed running straight
  // through and muxes it as its own track.
  const steady = audioPolicy === 'steadyStreams';
  const audioSlices = intercutAudioSlices(audioPolicy, plan);
  const pcmBySlot: Partial<Record<IntercutSlot, Int16Array>> = {};
  const audibleSources = steady
    ? sources
    : sources.filter((s) => framesNeeded(audioSlices, s.slot) > 0);
  for (const [i, source] of audibleSources.entries()) {
    onStatus(`Intercut: decoding audio from "${source.clip.title}"…`);
    emitProgress(onProgress, 'Intercut audio', 0.1 + (0.2 * i) / Math.max(1, audibleSources.length), false);
    // One frame of slack covers the crossfade tail, or a short source ending early.
    const needSec = steady
      ? outputDurationSec + 1 / INTERCUT_OUTPUT_FPS
      : (framesNeeded(audioSlices, source.slot) + 1) / INTERCUT_OUTPUT_FPS;
    pcmBySlot[source.slot] = await extractSourcePcm(ffmpeg, source, needSec, onStatus);
  }
  const audioName = 'intercut-audio.wav';
  const audioTracks: { name: string; title: string }[] = [];
  const writtenAudio: string[] = [];
  if (steady) {
    const beds = sources.map((source) => ({
      name: `intercut-audio-${source.slot.toLowerCase()}.wav`,
      title: `${source.slot} — ${source.clip.title}`,
      pcm: steadyStreamPcm(pcmBySlot[source.slot], plan.totalFrames),
    }));
    const mixName = 'intercut-audio-mix.wav';
    await safeWriteFile(
      ffmpeg,
      mixName,
      encodeWavPcm16(
        mixSteadyStreams(beds.map((bed) => bed.pcm)),
        INTERCUT_AUDIO_SAMPLE_RATE,
        INTERCUT_AUDIO_CHANNELS,
      ),
      'intercut write mix',
    );
    writtenAudio.push(mixName);
    audioTracks.push({ name: mixName, title: 'All (mix)' });
    for (const bed of beds) {
      await safeWriteFile(
        ffmpeg,
        bed.name,
        encodeWavPcm16(bed.pcm, INTERCUT_AUDIO_SAMPLE_RATE, INTERCUT_AUDIO_CHANNELS),
        `intercut write audio ${bed.title}`,
      );
      writtenAudio.push(bed.name);
      audioTracks.push({ name: bed.name, title: bed.title });
    }
  } else {
    await safeWriteFile(
      ffmpeg,
      audioName,
      encodeWavPcm16(
        assembleIntercutAudio({
          slices: audioSlices,
          totalFrames: plan.totalFrames,
          sources: pcmBySlot,
        }),
        INTERCUT_AUDIO_SAMPLE_RATE,
        INTERCUT_AUDIO_CHANNELS,
      ),
      'intercut write audio',
    );
    writtenAudio.push(audioName);
  }

  const visibleSources = sources.filter((s) => framesNeeded(plan.slices, s.slot) > 0);
  const { width, height } = resolveTargetResolution(
    intercutSourceClips(config),
    DEFAULT_EXPORT_SETTINGS,
  );
  const filterGraph = buildIntercutVideoFilterGraph(
    plan,
    visibleSources.map((s, inputIndex) => ({ slot: s.slot, inputIndex })),
    width,
    height,
  );
  const sourceInputs = visibleSources.map((s) =>
    buildIntercutSourceInputArgs(
      s.clip,
      s.vfsName,
      s.trimStart,
      // Two frames past the last one read so `fps` never runs dry on rounding.
      (framesNeeded(plan.slices, s.slot) + 2) / INTERCUT_OUTPUT_FPS,
    ),
  );

  onStatus(
    `Intercut: rendering ${plan.slices.length} cut${plan.slices.length === 1 ? '' : 's'} at ${width}×${height}…`,
  );
  emitProgress(onProgress, 'Intercut render', 0.35, false);
  try {
    await safeExec(
      ffmpeg,
      buildIntercutRenderArgs({
        sourceInputs,
        audioName: steady ? undefined : audioName,
        audioTracks: steady ? audioTracks : undefined,
        filterGraph,
        totalFrames: plan.totalFrames,
        outputName,
      }),
      {
        stage: 'Intercut render',
        totalDuration: outputDurationSec,
        rangeStart: 0.35,
        rangeEnd: 0.95,
        onProgress,
      },
      `intercut generate (${plan.slices.length} slices)`,
    );
  } finally {
    for (const name of writtenAudio) await deleteQuiet(ffmpeg, name);
  }

  emitProgress(onProgress, 'Intercut render', 1, false);
  return {
    slices,
    usedStreamCopy: false,
    outputDurationSec,
    didNormalize: intercutNeedsNormalization(config.clipA, config.clipB, config.clipC),
  };
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

  const vfsNames = [vfsNameA, vfsNameB, vfsNameC, outputName].filter(
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
