import { fetchFile } from "@ffmpeg/util";
import type { TextOverlay } from "../types";
import { assertValidBundledFontBytes } from "../utils/fontBytes";
import {
  buildDrawtextFilter,
  getFontPublicUrl,
  getBundledFont,
  resolveFontFileForOverlay,
} from "../utils/textOverlay";
import {
  bakeSecondaryColorLut,
  secondaryHasHueGrades,
  secondaryHasWindowGrades,
  secondaryLutToCubeText,
  SECONDARY_COLOR_LUT_FILENAME,
  type SecondaryColorSettings,
} from "../utils/secondaryColor";
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
export {
  buildSilentAacLoopInputArgs,
  ensureSilentAacUnit,
  SILENT_AAC_UNIT_NAME,
} from "./silentAudio";
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

/** Detect missing-video FFmpeg failures (e.g. audio-only `.mp4` tagged as video). */
export function isNoVideoStreamError(error: unknown): boolean {
  const text = [
    extractErrorMessage(error),
    error instanceof Error ? error.message : "",
    (error as { lastFfmpegError?: string }).lastFfmpegError ?? "",
    getLastFfmpegError() ?? "",
  ].join("\n");
  return /0:v/.test(text) && /matches no streams|Invalid video stream/i.test(text);
}
