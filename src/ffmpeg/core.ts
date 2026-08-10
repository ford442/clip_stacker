import { fetchFile } from "@ffmpeg/util";
import type {
  Clip,
  ExportSettings,
  ClipTransition,
  TextOverlay,
} from "../types";
import { getClipDuration } from "../utils/project";
import { resolveTargetResolution } from "../utils/resolution";
import { audioVolumeFilterSegment, clipHasVolumeAdjustment } from "../utils/audioVolume";
import {
  audioTempoFilterSegment,
  clipHasPlaybackRateAdjustment,
  getClipPlaybackRate,
  videoSetptsFilter,
} from "../utils/playbackRate";
import { assertValidBundledFontBytes } from "../utils/fontBytes";
import {
  buildDrawtextFilter,
  getFontPublicUrl,
  getBundledFont,
  resolveFontFileForOverlay,
} from "../utils/textOverlay";
import {
  appendPrimaryColorFilters,
  buildPrimaryColorFfmpegFilters,
  type PrimaryColorSettings,
} from "../utils/primaryColor";
import {
  appendNoiseReductionFilters,
  buildNoiseReductionFfmpegFilters,
  type NoiseReductionSettings,
} from "../utils/noiseReduction";
import {
  appendSecondaryColorFilters,
  bakeSecondaryColorLut,
  buildSecondaryColorFfmpegFilters,
  secondaryHasHueGrades,
  secondaryHasWindowGrades,
  secondaryLutToCubeText,
  SECONDARY_COLOR_LUT_FILENAME,
  type SecondaryColorSettings,
} from "../utils/secondaryColor";
import {
  appendSharpenFilters,
  buildSharpenFfmpegFilters,
  type SharpenSettings,
} from "../utils/sharpen";
import {
  appendGrainFilters,
  buildGrainFfmpegFilters,
  type GrainSettings,
} from "../utils/grain";
import type { IFfmpegRuntime } from "./ffmpegRuntime";
import {
  buildFfmpegLoadErrorMessage,
  clampProgress,
  emitLoadStatus,
  emitProgress,
  extractErrorMessage,
  FFMPEG_CORE_CDNS,
  FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
  FFMPEG_LOAD_TIMEOUT_MS,
  getCdnLabel,
  getFfmpegCoreSources,
  getFfmpegEnvironmentDiagnostics,
  getLocalFfmpegCoreBaseURL,
  parseFfmpegTimeSeconds,
  toBlobURLWithRetry as toBlobURLWithRetryBase,
  toBlobURLWithFallback as toBlobURLWithFallbackBase,
  withTimeout,
  type FfmpegLogProgressContext,
  type ProgressCallback,
  type RenderProgressUpdate,
  type StatusCallback,
} from "./ffmpegCommon";
import {
  FfmpegManager,
  getFfmpegManager,
  MAX_LOG_BUFFER,
  setFfmpegManagerForTesting,
} from "./ffmpegManager";

export { buildDrawtextFilter } from "../utils/textOverlay";
export type {
  FfmpegLogProgressContext,
  ProgressCallback,
  RenderProgressUpdate,
  StatusCallback,
} from "./ffmpegCommon";
export type { IFfmpegRuntime } from "./ffmpegRuntime";
export {
  FfmpegManager,
  getFfmpegManager,
  setFfmpegManagerForTesting,
  resetFfmpegManagerForTesting,
} from "./ffmpegManager";

export const DEFAULT_VIDEO_SIZE = "1280x720";
export const OUTPUT_WIDTH = 1280;
export const OUTPUT_HEIGHT = 720;
export const PASS1_PROGRESS_START = 0.12;
export const PASS1_PROGRESS_END = 0.85;

/**
 * URL for Roboto Regular TTF bundled with the app.
 * FFmpeg WASM has no system fonts, so we fetch this at render time and write
 * it to the virtual filesystem as 'roboto.ttf'.
 */
export const FONT_CDN_URL = getFontPublicUrl(getBundledFont("roboto"));
export const FONT_VIRTUAL_NAME = "roboto.ttf";

/** Map from virtual filename to its public URL for all bundled fonts. */
const FONT_URL_BY_VIRTUAL: Record<string, string> = Object.fromEntries(
  ["roboto", "robotoBold", "serif", "mono"].map((id) => {
    const font = getBundledFont(id);
    return [font.virtualName, getFontPublicUrl(font)] as const;
  }),
);

function manager(): FfmpegManager {
  return getFfmpegManager();
}

export function isFfmpegLoadFailed(): boolean {
  return manager().isLoadFailed();
}

export function isFfmpegLoading(): boolean {
  return manager().isLoading();
}

export function recordFfmpegLog(message: string): void {
  manager().recordLog(message);
}

export function getLastFfmpegLogs(count = 50): string[] {
  return manager().getLastLogs(count);
}

export function getLastFfmpegError(): string | null {
  return manager().getLastError();
}

export function getLastFfmpegCommand(): string[] | null {
  return manager().getLastCommand();
}

export function getLastFfmpegFilterComplex(): string | null {
  return manager().getLastFilterComplex();
}

export function clearFfmpegLogs(): void {
  manager().clearLogs();
}

export { MAX_LOG_BUFFER };

export function buildDetailedError(
  operation: string,
  originalError: unknown,
): Error {
  const recent = getLastFfmpegLogs(25).join("\n");
  const errMsg = extractErrorMessage(originalError);
  const lastErr = getLastFfmpegError()
    ? `\nLast relevant FFmpeg log: ${getLastFfmpegError()}`
    : "";
  const full = `${operation} failed: ${errMsg}${lastErr}\n\n--- Recent FFmpeg logs (last 25) ---\n${recent || "(no logs captured)"}\n--- End FFmpeg logs ---`;
  const e = new Error(full);
  (e as any).ffmpegLogs = getLastFfmpegLogs(50);
  (e as any).lastFfmpegError = getLastFfmpegError();
  return e;
}

export {
  extractErrorMessage,
  normalizeError,
  clampProgress,
  emitProgress,
  emitLoadStatus,
  getCdnLabel,
  getLocalFfmpegCoreBaseURL,
  getFfmpegCoreSources,
  buildFfmpegLoadErrorMessage,
  parseFfmpegTimeSeconds,
  getFfmpegEnvironmentDiagnostics,
  withTimeout,
  FFMPEG_CORE_CDNS,
  FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
  FFMPEG_LOAD_TIMEOUT_MS,
} from "./ffmpegCommon";

export async function toBlobURLWithRetry(
  url: string,
  mimeType: string,
  onStatus?: StatusCallback,
  onProgress?: ProgressCallback,
  label?: string,
): Promise<string> {
  return toBlobURLWithRetryBase(
    url,
    mimeType,
    onStatus,
    onProgress,
    label,
    recordFfmpegLog,
  );
}

export async function toBlobURLWithFallback(
  filename: string,
  mimeType: string,
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  label: string,
): Promise<string> {
  return toBlobURLWithFallbackBase(
    filename,
    mimeType,
    onStatus,
    onProgress,
    label,
    recordFfmpegLog,
  );
}

export async function safeExec(
  ffmpeg: IFfmpegRuntime,
  args: string[],
  context: FfmpegLogProgressContext | null,
  operation: string,
): Promise<void> {
  try {
    manager().setLastCommand(args);
    if (context) {
      await execWithFfmpegProgress(ffmpeg, args, context);
    } else {
      await ffmpeg.exec(args);
    }
  } catch (err) {
    throw buildDetailedError(operation, err);
  }
}

/** Safe writeFile with diagnostics on failure (OOM, VFS full, permission, etc.). */
export async function safeWriteFile(
  ffmpeg: IFfmpegRuntime,
  name: string,
  data: Uint8Array | string,
  operation = "writeFile",
): Promise<void> {
  try {
    await ffmpeg.writeFile(name, data as any);
  } catch (err) {
    throw buildDetailedError(`${operation} ${name}`, err);
  }
}

/**
 * Bake hue-only secondary grades into a `.cube` on the FFmpeg VFS for `lut3d`.
 * Window masks have no FFmpeg parity — status notes that when relevant.
 * Returns the pass when a lut3d filter should be appended; otherwise undefined.
 */
export async function prepareSecondaryColorFfmpeg(
  ffmpeg: IFfmpegRuntime,
  pass: SecondaryColorSettings | undefined,
  onStatus: StatusCallback,
): Promise<SecondaryColorSettings | undefined> {
  if (!pass?.enabled) return undefined;
  if (secondaryHasWindowGrades(pass)) {
    onStatus(
      "Secondary window masks are WebGPU-only — FFmpeg applies hue-only grades via lut3d when present.",
    );
  }
  if (!secondaryHasHueGrades(pass)) {
    return undefined;
  }
  const lut = bakeSecondaryColorLut(pass);
  if (!lut) return undefined;
  await safeWriteFile(
    ffmpeg,
    SECONDARY_COLOR_LUT_FILENAME,
    secondaryLutToCubeText(lut),
    "write secondary lut3d",
  );
  onStatus("Secondary color: baked hue grades to lut3d for FFmpeg path.");
  return pass;
}

/** Safe readFile with diagnostics. */
export async function safeReadFile(
  ffmpeg: IFfmpegRuntime,
  name: string,
  operation = "readFile",
): Promise<Uint8Array> {
  try {
    return (await ffmpeg.readFile(name)) as Uint8Array;
  } catch (err) {
    throw buildDetailedError(`${operation} ${name}`, err);
  }
}

export async function execWithFfmpegProgress(
  ffmpeg: IFfmpegRuntime,
  args: string[],
  context: FfmpegLogProgressContext,
): Promise<void> {
  const mgr = manager();
  const previousContext = mgr.activeLogProgress;
  mgr.activeLogProgress = context;
  try {
    await ffmpeg.exec(args);
  } finally {
    mgr.activeLogProgress = previousContext;
  }
}

export function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === "audio") return true;
  if (clip.rifeProcessed) return true;
  return (
    clip.videoFadeIn > 0 ||
    clip.videoFadeOut > 0 ||
    clip.audioFadeIn > 0 ||
    clip.audioFadeOut > 0 ||
    clipHasVolumeAdjustment(clip) ||
    clipHasPlaybackRateAdjustment(clip)
  );
}

/** CFR frame rate for still-image clips materialized as MP4 (NLE-friendly). */
export const STILL_IMAGE_OUTPUT_FPS = 30;

const STILL_IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

/** True when the clip source is a still image (flag or image file extension). */
export function isStillImageClip(
  clip: Pick<Clip, "stillImage" | "file">,
): boolean {
  // Materialized video (e.g. after RIFE) is no longer an image source for FFmpeg.
  if (clip.file.type.startsWith("video/")) return false;
  return clip.stillImage === true || STILL_IMAGE_FILE_RE.test(clip.file.name);
}

/** Still images and image files have no audio stream in FFmpeg. */
export function clipHasSourceAudio(clip: Clip): boolean {
  if (clip.kind === "audio") return true;
  if (isStillImageClip(clip)) return false;
  return true;
}

/** Loop single-frame image inputs so trim/duration filters can reach clip length. */
export function clipNeedsLoopInput(clip: Clip): boolean {
  return isStillImageClip(clip);
}

function evenVideoDimension(value: number): number {
  const n = Math.max(2, Math.floor(value));
  return n % 2 === 0 ? n : n - 1;
}

/** Target encode size for a still image (even dimensions for yuv420p). */
export function resolveStillImageEncodeDimensions(
  clip: Pick<Clip, "videoWidth" | "videoHeight">,
): { width: number; height: number } {
  const width = evenVideoDimension(clip.videoWidth ?? OUTPUT_WIDTH);
  const height = evenVideoDimension(clip.videoHeight ?? OUTPUT_HEIGHT);
  return { width, height };
}

/** Video filter chain for edit-friendly still-image MP4 output. */
export function buildStillImageVideoFilter(
  width: number,
  height: number,
  fps: number = STILL_IMAGE_OUTPUT_FPS,
): string {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");
}

export interface StillImageEncodeOptions {
  inputName: string;
  outputName: string;
  durationSec: number;
  width: number;
  height: number;
}

/**
 * FFmpeg CLI args that turn a still image into an H.264+AAC MP4 hold clip.
 * Uses CFR, regular keyframes, and faststart for broad NLE compatibility.
 */
export function buildStillImageFfmpegArgs(
  options: StillImageEncodeOptions,
): string[] {
  const { inputName, outputName, width, height } = options;
  const durationSec = Math.max(0.1, options.durationSec);
  const gop = STILL_IMAGE_OUTPUT_FPS;
  const vf = buildStillImageVideoFilter(width, height);

  return [
    "-loop",
    "1",
    "-t",
    String(durationSec),
    "-i",
    inputName,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=channel_layout=stereo:sample_rate=44100:d=${durationSec}`,
    "-vf",
    vf,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-tune",
    "stillimage",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-vsync",
    "cfr",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-movflags",
    "+faststart",
    "-t",
    String(durationSec),
    outputName,
  ];
}

/** Convenience wrapper using clip native dimensions when available. */
export function buildStillImageFfmpegArgsForClip(
  clip: Pick<Clip, "videoWidth" | "videoHeight">,
  inputName: string,
  outputName: string,
  durationSec: number,
): string[] {
  const { width, height } = resolveStillImageEncodeDimensions(clip);
  return buildStillImageFfmpegArgs({
    inputName,
    outputName,
    durationSec,
    width,
    height,
  });
}

export function buildClipInputArgs(clip: Clip): string[] {
  const input = clip.inputName!;
  if (clipNeedsLoopInput(clip)) return ["-loop", "1", "-i", input];
  return ["-i", input];
}

export function getSafeExtension(
  fileName: string,
  defaultExtension: string,
): string {
  const match = /\.([^.]+)$/.exec(fileName);
  const raw = match?.[1]?.toLowerCase();
  return raw && /^[a-z0-9]+$/.test(raw) ? raw : defaultExtension;
}

export function buildSingleClipFilter(
  clip: Clip,
  targetWidth: number = OUTPUT_WIDTH,
  targetHeight: number = OUTPUT_HEIGHT,
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): string {
  const duration = getClipDuration(clip);
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const safeVideoOut = Math.max(0, duration - clip.videoFadeOut);
  const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);
  const rate = getClipPlaybackRate(clip);
  const setpts = videoSetptsFilter(rate);
  const atempo = audioTempoFilterSegment(rate);
  const parts: string[] = [];

  if (clip.kind === "video") {
    let v = `[0:v]trim=start=${clip.trimStart}:end=${end},${setpts}`;
    v += `,scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`;
    v += `,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    if (clip.videoFadeIn > 0) v += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
    if (clip.videoFadeOut > 0)
      v += `,fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut}`;
    // Finishing: noise → primary → secondary (lut3d) → sharpen → grain (linear).
    const noiseFilters = buildNoiseReductionFfmpegFilters(noiseReduction);
    if (noiseFilters) v += `,${noiseFilters}`;
    const primaryFilters = buildPrimaryColorFfmpegFilters(primaryColor);
    if (primaryFilters) v += `,${primaryFilters}`;
    const secondaryFilters = buildSecondaryColorFfmpegFilters(secondaryColor);
    if (secondaryFilters) v += `,${secondaryFilters}`;
    const sharpenFilters = buildSharpenFfmpegFilters(sharpen);
    if (sharpenFilters) v += `,${sharpenFilters}`;
    // Linear grain only here (noise+vignette); bloom uses labeled pads via appendGrainFilters.
    const grainFilters = buildGrainFfmpegFilters(grain);
    if (grainFilters) v += `,${grainFilters}`;
    parts.push(`${v}[vout]`);

    if (clipHasSourceAudio(clip)) {
      let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS${atempo},aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`;
      if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
      if (clip.audioFadeOut > 0)
        a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
      a += audioVolumeFilterSegment(clip.volume ?? 1);
      parts.push(`${a}[aout]`);
    } else {
      parts.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100:d=${duration}[aout]`,
      );
    }
  } else {
    // Synthesize a black video track for audio-only clips at the master canvas size.
    parts.push(
      `color=c=black:s=${targetWidth}x${targetHeight}:d=${duration},format=yuv420p[vout]`,
    );

    let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS${atempo},aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0)
      a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    a += audioVolumeFilterSegment(clip.volume ?? 1);
    parts.push(`${a}[aout]`);
  }

  return parts.join(";");
}

export async function ensureFfmpeg(
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<IFfmpegRuntime> {
  return manager().ensureFfmpeg(onStatus, onProgress);
}

/**
 * Fetch a bundled TTF font and write it to the FFmpeg virtual filesystem.
 * If `virtualName` is omitted, loads the default Roboto Regular.
 * Subsequent calls for the same virtual name are no-ops for the current instance.
 */
export async function ensureFont(
  ffmpeg: IFfmpegRuntime,
  onStatus: StatusCallback,
  virtualName: string = FONT_VIRTUAL_NAME,
): Promise<void> {
  const mgr = manager();
  if (mgr.isFontLoaded(virtualName)) return;
  const url = FONT_URL_BY_VIRTUAL[virtualName] ?? FONT_CDN_URL;
  onStatus("Loading font for text overlays...");
  try {
    const fontData = await fetchFile(url);
    assertValidBundledFontBytes(fontData, url);
    await safeWriteFile(ffmpeg, virtualName, fontData, "ensureFont write");
    mgr.markFontLoaded(virtualName);
  } catch (err) {
    // If already a detailed error from safeWrite, rethrow as-is
    if ((err as any).ffmpegLogs) throw err;
    throw new Error(
      `Failed to load font for text overlays: ${(err as Error).message}`,
    );
  }
}

/**
 * Ensure all fonts required by the given overlays are present in the
 * FFmpeg VFS. Safe to call with an empty list (no-op).
 */
export async function ensureFontsForOverlays(
  ffmpeg: IFfmpegRuntime,
  onStatus: StatusCallback,
  overlays: TextOverlay[],
): Promise<void> {
  const needed = new Set<string>();
  for (const o of overlays) {
    const vname = resolveFontFileForOverlay(o);
    needed.add(vname);
  }
  for (const vname of needed) {
    await ensureFont(ffmpeg, onStatus, vname);
  }
}

/**
 * Append drawtext filters for the given text overlays onto the final video
 * output of a filter_complex graph, so text rendering happens in the same
 * encode pass as the composite/transition render instead of a second
 * full re-encode.
 *
 * Renames the graph's existing `[vout]` sink to `[vpretext]` and chains the
 * drawtext filters from there back onto `[vout]`. Assumes `[vout]` is the
 * sole final video sink label (true for buildPipFilterComplex and
 * buildTransitionFilterComplex).
 */
export function appendTextOverlayFilters(
  filterComplex: string,
  textOverlays: TextOverlay[],
): string {
  if (textOverlays.length === 0) return filterComplex;
  const drawtextChain = textOverlays
    .map((overlay) => buildDrawtextFilter(overlay))
    .join(",");
  const rewritten = filterComplex.replace(/\[vout\]/g, "[vpretext]");
  return `${rewritten};[vpretext]${drawtextChain}[vout]`;
}

// Fast path: copy video streams (no decode/encode) but normalize audio to AAC.
// We process each clip individually rather than using a single concat-demuxer
// pass because the concat demuxer can silently drop audio when any file in the
// list lacks an audio stream, or when clips have inconsistent audio codecs
// (e.g. Opus in WebM vs AAC in MP4).  Processing per-clip mirrors the two-pass
// encode path and is the only reliable way to guarantee audio in the output.
export async function mergeClipsLossless(
  ffmpeg: IFfmpegRuntime,
  clips: Clip[],
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<void> {
  onStatus("FFmpeg path: fast copy (video copy + audio normalize).");
  emitProgress(onProgress, "FFmpeg fast concat", 0.12, false);

  // Pass 1: per-clip intermediates (video copy + audio → AAC).
  // If a clip has no audio stream we add a silent AAC track so that all
  // intermediates have identical streams, which the concat demuxer requires.
  const intermediates: string[] = [];
  for (const [index, clip] of clips.entries()) {
    const outName = `lossless-${index}.mp4`;
    const clipDuration = getClipDuration(clip);
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    onStatus(`Fast copy [${index + 1}/${clips.length}]: "${clip.title}"...`);

    // Still images cannot be stream-copied: FFmpeg would mux PNG/MJPEG frames into
    // MP4, which breaks concat with H.264 neighbours and fails in most NLEs.
    if (isStillImageClip(clip)) {
      onStatus(`Encoding still image "${clip.title}" to H.264…`);
      await safeExec(
        ffmpeg,
        buildStillImageFfmpegArgsForClip(
          clip,
          clip.inputName!,
          outName,
          clipDuration,
        ),
        null,
        `Lossless still encode ${index + 1}/${clips.length} "${clip.title}"`,
      );
      intermediates.push(outName);
      continue;
    }

    let primaryArgs: string[];
    let silentAudioArgs: string[];

    if (clip.trimStart > 0) {
      // `-ss` before `-i` combined with `-c:v copy` can't cut mid-GOP: ffmpeg
      // rounds the seek down to the keyframe at/before trimStart and re-includes
      // everything from that keyframe up to trimStart in the output, while
      // -avoid_negative_ts make_zero collapses that leading span to PTS=0. The
      // re-encoded audio track *does* seek accurately to trimStart, so the
      // result is a silent video-only lead-in showing the footage the user
      // trimmed away — a frozen/paused start to the render. Re-encode the
      // video via trim+setpts for clips with a non-zero trim-in so both
      // streams start exactly at trimStart.
      const videoFilter = `[0:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS[vout]`;
      const audioFilter = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[aout]`;
      const encodeTail: string[] = [
        "-c:v",
        "libx264",
        "-crf",
        "16",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-b:a",
        "192k",
        outName,
      ];
      primaryArgs = [
        ...buildClipInputArgs(clip),
        "-filter_complex",
        `${videoFilter};${audioFilter}`,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        ...encodeTail,
      ];
      silentAudioArgs = [
        ...buildClipInputArgs(clip),
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-filter_complex",
        videoFilter,
        "-map",
        "[vout]",
        "-map",
        "1:a",
        "-t",
        String(clipDuration),
        ...encodeTail,
      ];
    } else {
      const durationArgs: string[] = Number.isFinite(clip.trimEnd)
        ? ["-t", String(clipDuration)]
        : [];
      const codecTail: string[] = [
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-avoid_negative_ts",
        "make_zero",
        outName,
      ];
      primaryArgs = [...buildClipInputArgs(clip), ...durationArgs, ...codecTail];
      silentAudioArgs = [
        ...buildClipInputArgs(clip),
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-map",
        "0:v",
        "-map",
        "1:a",
        ...durationArgs,
        ...codecTail,
      ];
    }

    if (!clipHasSourceAudio(clip)) {
      onStatus(`Clip "${clip.title}" has no audio — adding silence...`);
      await safeExec(
        ffmpeg,
        silentAudioArgs,
        null,
        `Lossless copy clip ${index + 1}/${clips.length} "${clip.title}" (silent audio)`,
      );
    } else {
      try {
        await safeExec(
          ffmpeg,
          primaryArgs,
          null,
          `Lossless copy clip ${index + 1}/${clips.length} "${clip.title}"`,
        );
      } catch (err) {
        // Retry without source audio if the clip has no audio stream.  Add an
        // anullsrc generator as a second input so the intermediate still carries
        // a silent AAC track — necessary for a consistent stream layout when the
        // final concat step combines clips with and without original audio.
        if (!isNoAudioStreamError(err)) throw err;
        onStatus(`Clip "${clip.title}" has no audio — adding silence...`);
        await safeExec(
          ffmpeg,
          silentAudioArgs,
          null,
          `Lossless copy clip ${index + 1}/${clips.length} "${clip.title}" (silent audio)`,
        );
      }
    }

    intermediates.push(outName);
    emitProgress(
      onProgress,
      "FFmpeg fast concat",
      0.12 + (0.73 * (index + 1)) / clips.length,
      false,
    );
  }

  // Pass 2: stream-copy all intermediates (identical codec → no re-encode).
  const concatList = intermediates.map((n) => `file '${n}'`).join("\n");
  await safeWriteFile(
    ffmpeg,
    "concat_list.txt",
    concatList,
    "lossless concat list",
  );
  await safeExec(
    ffmpeg,
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat_list.txt",
      "-c",
      "copy",
      "stacked.mp4",
    ],
    null,
    "Lossless concat pass 2",
  );
  emitProgress(onProgress, "FFmpeg fast concat", 0.9, false);

  try {
    await ffmpeg.deleteFile("concat_list.txt");
  } catch {
    /* ignore */
  }
  for (const name of intermediates) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }
}

// Perform two-pass re-encoding for clips with effects
export async function performTwoPassEncode(
  ffmpeg: IFfmpegRuntime,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): Promise<void> {
  emitProgress(onProgress, "FFmpeg re-encode (two-pass)", 0.12, false);

  // Every clip is normalized to this single resolution so the stitched output
  // never changes size mid-playback when clips have different dimensions.
  const { width: targetWidth, height: targetHeight } = resolveTargetResolution(
    clips,
    settings,
  );

  const intermediates: string[] = [];
  const pass1TotalDuration = clips.reduce(
    (sum, clip) => sum + getClipDuration(clip),
    0,
  );
  let pass1ElapsedDuration = 0;
  for (const [index, clip] of clips.entries()) {
    const clipDuration = getClipDuration(clip);
    const localStart =
      pass1TotalDuration > 0
        ? pass1ElapsedDuration / pass1TotalDuration
        : index / clips.length;
    const localEnd =
      pass1TotalDuration > 0
        ? (pass1ElapsedDuration + clipDuration) / pass1TotalDuration
        : (index + 1) / clips.length;
    const rangeStart =
      PASS1_PROGRESS_START +
      localStart * (PASS1_PROGRESS_END - PASS1_PROGRESS_START);
    const rangeEnd =
      PASS1_PROGRESS_START +
      localEnd * (PASS1_PROGRESS_END - PASS1_PROGRESS_START);
    intermediates.push(
      await processClipPass1(
        ffmpeg,
        clip,
        index,
        clips.length,
        settings,
        onStatus,
        onProgress,
        rangeStart,
        rangeEnd,
        targetWidth,
        targetHeight,
        primaryColor,
        noiseReduction,
        sharpen,
        secondaryColor,
        grain,
      ),
    );
    pass1ElapsedDuration += clipDuration;
  }
  await mergeClipsPass2(
    ffmpeg,
    intermediates,
    onStatus,
    totalDuration,
    onProgress,
  );
}

// Pass 1: produce one intermediate mp4 per clip.
export async function processClipPass1(
  ffmpeg: IFfmpegRuntime,
  clip: Clip,
  index: number,
  total: number,
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  rangeStart: number,
  rangeEnd: number,
  targetWidth: number = OUTPUT_WIDTH,
  targetHeight: number = OUTPUT_HEIGHT,
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): Promise<string> {
  const outName = `intermediate-${index}.mp4`;
  const clipDuration = getClipDuration(clip);
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;

  // A clip can be stream-copied only when it has no effects AND already matches
  // the target resolution. Otherwise it must be re-encoded (scaled/padded) so
  // every intermediate shares one resolution — concatenating mismatched sizes
  // makes the stitched output change resolution when the clip changes.
  const matchesTargetResolution =
    clip.kind === "video" &&
    clip.videoWidth === targetWidth &&
    clip.videoHeight === targetHeight;

  const primaryFilters = buildPrimaryColorFfmpegFilters(primaryColor);
  const needsPrimary = Boolean(primaryFilters);
  const noiseFilters = buildNoiseReductionFfmpegFilters(noiseReduction);
  const needsNoise = Boolean(noiseFilters);
  const sharpenFilters = buildSharpenFfmpegFilters(sharpen);
  const needsSharpen = Boolean(sharpenFilters);
  const grainFilters = buildGrainFfmpegFilters(grain);
  const needsGrain = Boolean(grainFilters);
  const secondaryFilters = buildSecondaryColorFfmpegFilters(secondaryColor);
  const needsSecondary = Boolean(secondaryFilters);

  if (
    !clipNeedsEffects(clip) &&
    !isStillImageClip(clip) &&
    matchesTargetResolution &&
    !needsPrimary &&
    !needsNoise &&
    !needsSharpen &&
    !needsGrain &&
    !needsSecondary
  ) {
    // Fast path: copy video (no decode/encode) + normalize audio to AAC.
    // Audio must be explicitly transcoded so the intermediate has a consistent
    // codec for concat — pure -c copy silently drops audio from non-MP4 sources.
    onStatus(
      `Pass 1 [${index + 1}/${total}]: Copying "${clip.title}" (no effects)...`,
    );
    const args: string[] = [];
    if (clip.trimStart > 0) args.push("-ss", String(clip.trimStart));
    args.push("-i", clip.inputName!);
    if (Number.isFinite(clip.trimEnd)) args.push("-t", String(clipDuration));
    args.push(
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "192k",
      "-avoid_negative_ts",
      "make_zero",
      outName,
    );
    await safeExec(
      ffmpeg,
      args,
      {
        stage: `Pass 1: ${clip.title}`,
        totalDuration: clipDuration,
        rangeStart,
        rangeEnd,
        onProgress,
      },
      `Pass 1 copy for clip ${index + 1}/${total} "${clip.title}"`,
    );
    return outName;
  }

  // Normalize-only path: a clean video clip whose native size differs from the
  // target. Scale/pad to the target resolution (and normalize audio to AAC) so
  // it concatenates seamlessly. Handles clips without an audio stream by
  // synthesizing silence, mirroring the lossless path.
  if (!clipNeedsEffects(clip) && clip.kind === "video") {
    onStatus(
      `Pass 1 [${index + 1}/${total}]: Normalizing "${clip.title}" to ${targetWidth}x${targetHeight}...`,
    );
    const videoFilter =
      `[0:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS` +
      `,scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease` +
      `,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p` +
      (noiseFilters ? `,${noiseFilters}` : '') +
      (primaryFilters ? `,${primaryFilters}` : '') +
      (sharpenFilters ? `,${sharpenFilters}` : '') +
      (grainFilters ? `,${grainFilters}` : '') +
      `[vout]`;
    const audioFilter =
      `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS` +
      `,aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[aout]`;
    const encodeTail = [
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-crf",
      String(settings.crf),
      "-preset",
      settings.preset,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "192k",
      outName,
    ];
    const progressCtx = {
      stage: `Pass 1: ${clip.title}`,
      totalDuration: clipDuration,
      rangeStart,
      rangeEnd,
      onProgress,
    };

    const encodeWithSilentAudio = async () => {
      await safeExec(
        ffmpeg,
        [
          ...buildClipInputArgs(clip),
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=44100:cl=stereo",
          "-filter_complex",
          videoFilter,
          "-map",
          "[vout]",
          "-map",
          "1:a",
          "-t",
          String(clipDuration),
          ...encodeTail,
        ],
        progressCtx,
        `Pass 1 normalize for clip ${index + 1}/${total} "${clip.title}" (silent audio)`,
      );
    };

    if (!clipHasSourceAudio(clip)) {
      onStatus(`Clip "${clip.title}" has no audio — adding silence...`);
      await encodeWithSilentAudio();
      return outName;
    }

    try {
      await safeExec(
        ffmpeg,
        [
          ...buildClipInputArgs(clip),
          "-filter_complex",
          `${videoFilter};${audioFilter}`,
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          ...encodeTail,
        ],
        progressCtx,
        `Pass 1 normalize for clip ${index + 1}/${total} "${clip.title}"`,
      );
    } catch (err) {
      // Clip has no audio stream — add a silent AAC track so all intermediates
      // share an identical stream layout for concat.
      if (!isNoAudioStreamError(err)) throw err;
      onStatus(`Clip "${clip.title}" has no audio — adding silence...`);
      await encodeWithSilentAudio();
    }
    return outName;
  }

  // Re-encode path: clip has fades, is audio-only, or is RIFE-processed.
  onStatus(`Pass 1 [${index + 1}/${total}]: Encoding "${clip.title}"...`);
  await safeExec(
    ffmpeg,
    [
      ...buildClipInputArgs(clip),
      "-filter_complex",
      buildSingleClipFilter(clip, targetWidth, targetHeight, primaryColor, noiseReduction, sharpen, secondaryColor, grain),
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-crf",
      String(settings.crf),
      "-preset",
      settings.preset,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outName,
    ],
    {
      stage: `Pass 1: ${clip.title}`,
      totalDuration: clipDuration,
      rangeStart,
      rangeEnd,
      onProgress,
    },
    `Pass 1 encode for clip ${index + 1}/${total} "${clip.title}"`,
  );

  return outName;
}

// Pass 2: concatenate all intermediate files produced by Pass 1.
export async function mergeClipsPass2(
  ffmpeg: IFfmpegRuntime,
  intermediateNames: string[],
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  const concatList = intermediateNames.map((n) => `file '${n}'`).join("\n");
  await safeWriteFile(
    ffmpeg,
    "concat_list.txt",
    concatList,
    "pass2 concat list",
  );

  onStatus("Pass 2: Final concatenation...");
  await safeExec(
    ffmpeg,
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat_list.txt",
      "-c",
      "copy",
      "stacked.mp4",
    ],
    {
      stage: "Pass 2: Final concatenation",
      totalDuration,
      rangeStart: 0.85,
      rangeEnd: 0.95,
      onProgress,
    },
    "Pass 2 final concat exec",
  );

  try {
    await ffmpeg.deleteFile("concat_list.txt");
  } catch {
    /* ignore */
  }
  for (const name of intermediateNames) {
    await ffmpeg.deleteFile(name);
  }
}

/** Render all clips using a single filter_complex with xfade/acrossfade transitions. */
export async function mergeClipsWithTransitions(
  ffmpeg: IFfmpegRuntime,
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  filterComplex: string,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
  textOverlays: TextOverlay[] = [],
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): Promise<void> {
  onStatus("Building transition render...");
  emitProgress(onProgress, "FFmpeg transition render", 0.15, false);

  let effectiveFilterComplex = filterComplex;
  // Noise → primary → secondary (lut3d) → sharpen → grain before text overlays.
  effectiveFilterComplex = appendNoiseReductionFilters(effectiveFilterComplex, noiseReduction);
  effectiveFilterComplex = appendPrimaryColorFilters(effectiveFilterComplex, primaryColor);
  effectiveFilterComplex = appendSecondaryColorFilters(effectiveFilterComplex, secondaryColor);
  effectiveFilterComplex = appendSharpenFilters(effectiveFilterComplex, sharpen);
  effectiveFilterComplex = appendGrainFilters(effectiveFilterComplex, grain);
  if (textOverlays.length > 0) {
    await ensureFontsForOverlays(ffmpeg, onStatus, textOverlays);
    effectiveFilterComplex = appendTextOverlayFilters(effectiveFilterComplex, textOverlays);
  }

  const inputArgs: string[] = [];
  for (const clip of clips) {
    inputArgs.push("-i", clip.inputName!);
  }

  await safeExec(
    ffmpeg,
    [
      ...inputArgs,
      "-filter_complex",
      effectiveFilterComplex,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-crf",
      String(settings.crf),
      "-preset",
      settings.preset,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "stacked.mp4",
    ],
    {
      stage: "FFmpeg transition render",
      totalDuration,
      rangeStart: 0.15,
      rangeEnd: 0.95,
      onProgress,
    },
    "Transition filter_complex render",
  );
}

/**
 * Build the filter_complex string for a PiP / multi-layer compositing render.
 *
 * Clips with layerIndex === 0 (the default) form the base layer and are
 * concatenated sequentially.  Clips with layerIndex >= 1 are scaled, optionally
 * made semi-transparent, and overlaid on top of the base video at their (x, y)
 * position.  Overlay clips are stacked in ascending layerIndex order.
 *
 * Audio from all clips (base and overlay) is mixed together.
 */
export async function aggressiveCleanupFFmpegVFS(
  onStatus?: StatusCallback,
): Promise<void> {
  await manager().aggressiveCleanupVFS(onStatus);
}

/**
 * Reset the FFmpeg instance entirely, terminating the current instance
 * and forcing a fresh initialization on the next render.
 * This is a nuclear option for freeing all FFmpeg-related memory.
 * Useful when the instance encounters errors or memory pressure is too high.
 */
export async function resetFFmpegInstance(): Promise<void> {
  await manager().reset();
}

/**
 * Regex patterns that indicate the source file has no extractable audio
 * stream, used to convert the generic FFmpeg error into a user-friendly
 * message.
 */
export const NO_AUDIO_STREAM_RE =
  /matches no streams|does not contain|no audio|Output file does not contain|Invalid audio stream/i;

/** Detect missing-audio FFmpeg failures (worker often surfaces only "FS error"). */
export function isNoAudioStreamError(error: unknown): boolean {
  const parts = [
    extractErrorMessage(error),
    error instanceof Error ? error.message : "",
    (error as { lastFfmpegError?: string }).lastFfmpegError ?? "",
    getLastFfmpegError() ?? "",
  ];
  return NO_AUDIO_STREAM_RE.test(parts.join("\n"));
}
