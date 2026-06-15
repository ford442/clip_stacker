import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type {
  Clip,
  ExportSettings,
  ClipTransition,
  TextOverlay,
  RenderPlan,
} from "../types";
import { DEFAULT_EXPORT_SETTINGS } from "../types";
import { getClipDuration } from "../utils/project";
import { buildTransitionFilterComplex } from "../utils/transitions";
import { isValidFfmpegColor } from "../utils/color";
import { buildScrollXExpression } from "../utils/textOverlay";

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
export const FONT_CDN_URL = "/fonts/Roboto-Regular.ttf";
export const FONT_VIRTUAL_NAME = "roboto.ttf";

export let ffmpegInstance: FFmpeg | null = null;
export let fontLoaded = false;
export let ffmpegLoadingInstance: FFmpeg | null = null;

/**
 * In-flight promise for an ongoing ensureFfmpeg() call.
 * Subsequent callers await this same promise instead of racing to create
 * a second FFmpeg instance.
 */
export let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;

/** True if the last load attempt failed; cleared on a successful load. */
export let ffmpegLoadFailed = false;

/**
 * Monotonically increasing counter, bumped on every resetFFmpegInstance() call.
 * Used to prevent a stale in-flight load from overwriting the state after a
 * reset has already been issued.
 */
export let loadGeneration = 0;

export function isFfmpegLoadFailed(): boolean {
  return ffmpegLoadFailed;
}

export function isFfmpegLoading(): boolean {
  return ffmpegLoadingPromise !== null;
}

export type StatusCallback = (message: string) => void;
export interface RenderProgressUpdate {
  stage: string;
  /** 0..1 when known; undefined for indeterminate progress. */
  progress?: number;
  indeterminate?: boolean;
}
export type ProgressCallback = (update: RenderProgressUpdate) => void;

export interface FfmpegLogProgressContext {
  stage: string;
  totalDuration: number;
  rangeStart: number;
  rangeEnd: number;
  onProgress?: ProgressCallback;
}

export let activeFfmpegLogProgress: FfmpegLogProgressContext | null = null;

/** Ring buffer of the most recent FFmpeg log messages (for diagnostics on failure). */
export const MAX_LOG_BUFFER = 300;
export let ffmpegLogBuffer: string[] = [];
export let lastFfmpegErrorLog: string | null = null;

/** Append a log line to the diagnostic buffer and detect obvious error patterns. */
export function recordFfmpegLog(message: string): void {
  ffmpegLogBuffer.push(message);
  if (ffmpegLogBuffer.length > MAX_LOG_BUFFER) {
    ffmpegLogBuffer.shift();
  }
  // Capture the last line that looks like a hard failure for quick access.
  if (
    /error|failed|invalid|no such|cannot|unable|does not contain|matches no streams|Output file does not/i.test(
      message,
    )
  ) {
    lastFfmpegErrorLog = message;
  }
}

export function getLastFfmpegLogs(count = 50): string[] {
  return ffmpegLogBuffer.slice(-Math.max(1, count));
}

export function getLastFfmpegError(): string | null {
  return lastFfmpegErrorLog;
}

export function clearFfmpegLogs(): void {
  ffmpegLogBuffer = [];
  lastFfmpegErrorLog = null;
}

/** Build a rich error that includes recent FFmpeg logs for the user/developer. */
export function buildDetailedError(
  operation: string,
  originalError: unknown,
): Error {
  const recent = getLastFfmpegLogs(25).join("\n");
  const errMsg = (originalError as Error)?.message || String(originalError);
  const lastErr = lastFfmpegErrorLog
    ? `\nLast relevant FFmpeg log: ${lastFfmpegErrorLog}`
    : "";
  const full = `${operation} failed: ${errMsg}${lastErr}\n\n--- Recent FFmpeg logs (last 25) ---\n${recent || "(no logs captured)"}\n--- End FFmpeg logs ---`;
  const e = new Error(full);
  (e as any).ffmpegLogs = getLastFfmpegLogs(50);
  (e as any).lastFfmpegError = lastFfmpegErrorLog;
  return e;
}

/**
 * Normalise an unknown thrown value into a human-readable message.
 *
 * @ffmpeg/ffmpeg's worker rejects with `error.toString()` (a plain string,
 * e.g. "Error: failed to import ffmpeg-core.js"), so `(error as Error).message`
 * is `undefined` for these — which previously surfaced as the unhelpful
 * "FFmpeg load FAILED: undefined". Handle strings, Errors, and arbitrary
 * objects so the diagnostics always carry something actionable.
 */
export function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.toString();
  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage) return maybeMessage;
  }
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

export function clampProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress));
}

export function emitProgress(
  onProgress: ProgressCallback | undefined,
  stage: string,
  progress?: number,
  indeterminate = false,
): void {
  if (!onProgress) return;
  onProgress({
    stage,
    progress:
      typeof progress === "number" ? clampProgress(progress) : undefined,
    indeterminate: indeterminate || typeof progress !== "number",
  });
}

export function emitLoadStatus(
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  stage: string,
): void {
  onStatus(stage);
  emitProgress(onProgress, stage, undefined, true);
}

export function getCdnLabel(baseURL: string): string {
  if (baseURL.includes("/ffmpeg-core")) return "local hosted FFmpeg core";
  if (baseURL.includes("cdn.jsdelivr.net")) return "jsDelivr CDN";
  if (baseURL.includes("unpkg.com")) return "unpkg CDN";
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}

export function getLocalFfmpegCoreBaseURL(): string {
  const base =
    typeof document !== "undefined"
      ? document.baseURI
      : typeof window !== "undefined"
        ? window.location.href
        : "http://localhost/";
  return new URL("ffmpeg-core", base).href.replace(/\/$/, "");
}

export function getFfmpegCoreSources(): string[] {
  return [getLocalFfmpegCoreBaseURL(), ...FFMPEG_CORE_CDNS];
}

export function terminateFfmpegInstance(
  ffmpeg: FFmpeg | null,
  context: string,
): void {
  if (!ffmpeg) return;
  try {
    ffmpeg.terminate();
  } catch (error) {
    console.warn(`Failed to terminate FFmpeg during ${context}:`, error);
  }
}

export function clearTrackedLoadingInstance(
  ffmpeg: FFmpeg,
  terminate = false,
): void {
  if (ffmpegLoadingInstance !== ffmpeg) return;
  ffmpegLoadingInstance = null;
  if (terminate) {
    terminateFfmpegInstance(ffmpeg, "load cleanup");
  }
}

export function buildFfmpegLoadErrorMessage(
  message: string,
  attempts = 1,
): string {
  const prefix =
    attempts > 1
      ? `FFmpeg failed to load after ${attempts} attempts. `
      : "FFmpeg failed to initialize. ";
  return (
    prefix +
    "The browser could not download or start the FFmpeg WebAssembly core. " +
    'Check your network connection, try "Retry FFmpeg load", or refresh the page. ' +
    `Details: ${message}`
  );
}

export function parseFfmpegTimeSeconds(message: string): number | null {
  const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** Safe wrapper around exec that always augments rejection with recent logs + context. */
export async function safeExec(
  ffmpeg: FFmpeg,
  args: string[],
  context: FfmpegLogProgressContext | null,
  operation: string,
): Promise<void> {
  try {
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
  ffmpeg: FFmpeg,
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

/** Safe readFile with diagnostics. */
export async function safeReadFile(
  ffmpeg: FFmpeg,
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
  ffmpeg: FFmpeg,
  args: string[],
  context: FfmpegLogProgressContext,
): Promise<void> {
  const previousContext = activeFfmpegLogProgress;
  activeFfmpegLogProgress = context;
  try {
    await ffmpeg.exec(args);
  } finally {
    activeFfmpegLogProgress = previousContext;
  }
}

export function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === "audio") return true;
  if (clip.rifeProcessed) return true;
  return (
    clip.videoFadeIn > 0 ||
    clip.videoFadeOut > 0 ||
    clip.audioFadeIn > 0 ||
    clip.audioFadeOut > 0
  );
}

export function getSafeExtension(
  fileName: string,
  defaultExtension: string,
): string {
  const match = /\.([^.]+)$/.exec(fileName);
  const raw = match?.[1]?.toLowerCase();
  return raw && /^[a-z0-9]+$/.test(raw) ? raw : defaultExtension;
}

export function buildSingleClipFilter(clip: Clip): string {
  const duration = getClipDuration(clip);
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const safeVideoOut = Math.max(0, duration - clip.videoFadeOut);
  const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);
  const parts: string[] = [];

  if (clip.kind === "video") {
    let v = `[0:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS`;
    v += `,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`;
    v += `,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    if (clip.videoFadeIn > 0) v += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
    if (clip.videoFadeOut > 0)
      v += `,fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut}`;
    parts.push(`${v}[vout]`);

    let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0)
      a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    parts.push(`${a}[aout]`);
  } else {
    // Synthesize a black video track for audio-only clips at the master canvas size.
    parts.push(
      `color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:d=${duration},format=yuv420p[vout]`,
    );

    let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0)
      a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    parts.push(`${a}[aout]`);
  }

  return parts.join(";");
}

/**
 * CDN fallbacks for @ffmpeg/core@0.12.6 ESM assets, tried after local assets.
 *
 * IMPORTANT: these MUST be the ESM (`dist/esm`) build, not UMD. @ffmpeg/ffmpeg
 * spawns its worker with `{ type: "module" }`, where `importScripts()` is
 * unavailable. The worker therefore loads the core via
 * `(await import(coreURL)).default`. The UMD build only assigns
 * `createFFmpegCore` to `module.exports`/`exports`/`define`, none of which
 * exist in a module worker, so `.default` is undefined and the worker throws
 * "failed to import ffmpeg-core.js" (surfacing as the cryptic "FAILED:
 * undefined"). The ESM build exposes `export default createFFmpegCore`, which
 * is what the module worker needs.
 */
export const FFMPEG_CORE_CDNS = [
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm",
  "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm",
];

/** Timeout (ms) for downloading each FFmpeg core asset before trying another source. */
export const FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS = 45_000;

/** Timeout (ms) for the entire ffmpeg.load() call including WASM compilation. */
export const FFMPEG_LOAD_TIMEOUT_MS = 120_000; // 2 minutes

export function getFfmpegEnvironmentDiagnostics(): string[] {
  const lines: string[] = [];
  const globalScope = globalThis as typeof globalThis & {
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: typeof SharedArrayBuffer;
  };

  lines.push(
    `location=${typeof window !== "undefined" ? window.location.href : "n/a"}`,
  );
  lines.push(
    `protocol=${typeof window !== "undefined" ? window.location.protocol : "n/a"}`,
  );
  lines.push(`crossOriginIsolated=${globalScope.crossOriginIsolated === true}`);
  lines.push(`Worker=${typeof Worker !== "undefined"}`);
  lines.push(`WebAssembly=${typeof WebAssembly !== "undefined"}`);
  lines.push(
    `SharedArrayBuffer=${typeof globalScope.SharedArrayBuffer !== "undefined"}`,
  );
  lines.push(
    `hardwareConcurrency=${typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? "unknown") : "n/a"}`,
  );
  lines.push(`ffmpegCoreSources=${getFfmpegCoreSources().join(",")}`);
  lines.push("ffmpegClassWorkerURL=Vite bundled @ffmpeg/ffmpeg default worker");

  return lines;
}

/**
 * Attempt to fetch a URL as a blob URL, retrying up to maxRetries times with
 * exponential backoff.  Status updates are sent via onStatus so the user sees
 * granular progress.
 */
export async function toBlobURLWithRetry(
  url: string,
  mimeType: string,
  onStatus?: StatusCallback,
  onProgress?: ProgressCallback,
  label?: string,
): Promise<string> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (onStatus && label) {
        const suffix = attempt > 1 ? ` (attempt ${attempt}/${maxRetries})` : "";
        emitLoadStatus(
          onStatus,
          onProgress,
          `Downloading ${label}${suffix}...`,
        );
      }
      return await withTimeout(
        toBlobURL(url, mimeType),
        FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
        `Downloading ${label ?? url}`,
      );
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to load ${url} after ${maxRetries} retries: ${(error as Error).message}`,
        );
      }
      const delayMs = Math.pow(2, attempt) * 1000; // exponential backoff: 2s, 4s
      console.warn(
        `Failed to load ${url} (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`,
        error,
      );
      recordFfmpegLog(
        `[FFmpeg load] Download failed for ${url} (attempt ${attempt}): ${(error as Error).message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // TypeScript requires this for control flow analysis: while we know the loop either returns
  // or throws on the final attempt, TypeScript can't verify this without an explicit statement here.
  throw new Error(
    "toBlobURLWithRetry: Unexpected - loop should always return or throw",
  );
}

/**
 * Try the local hosted core first, then CDN fallbacks. This keeps production
 * renders independent of third-party CDN availability while retaining a
 * recovery path for local asset deployment mistakes.
 */
export async function toBlobURLWithFallback(
  filename: string,
  mimeType: string,
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  label: string,
): Promise<string> {
  let lastError: Error | null = null;
  const sources = getFfmpegCoreSources();
  for (const [index, baseURL] of sources.entries()) {
    const url = `${baseURL}/${filename}`;
    const cdnLabel = getCdnLabel(baseURL);
    try {
      return await toBlobURLWithRetry(
        url,
        mimeType,
        onStatus,
        onProgress,
        `${label} from ${cdnLabel}`,
      );
    } catch (err) {
      lastError = err as Error;
      recordFfmpegLog(
        `[FFmpeg load] Source ${baseURL} failed for ${filename}: ${lastError.message}`,
      );
      console.warn(
        `[FFmpeg load] Source ${baseURL} failed for ${filename}, trying next source...`,
      );
      if (index < sources.length - 1) {
        emitLoadStatus(
          onStatus,
          onProgress,
          `${cdnLabel} failed for ${label}. Trying the next FFmpeg source...`,
        );
      }
    }
  }
  throw new Error(
    `Failed to download ${filename} from local assets and all fallback CDNs. Last error: ${lastError?.message ?? "unknown"}`,
  );
}

/**
 * Race a promise against a timeout.  Throws if the timeout fires first.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Timed out after ${ms / 1000}s waiting for: ${label}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function _doLoadFfmpeg(
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<FFmpeg> {
  // Reset font state whenever a new FFmpeg instance is created.
  fontLoaded = false;

  const ffmpeg = new FFmpeg();
  ffmpegLoadingInstance = ffmpeg;

  // CRITICAL: capture EVERY log line. The old filter silently dropped all errors/warnings.
  ffmpeg.on("log", ({ message }) => {
    recordFfmpegLog(message);
    // Always surface to console for developers (was completely invisible before).
    console.log("[FFmpeg]", message);

    // Only drive progress/status from time= lines (keep UX clean).
    if (!message.includes("time=")) return;
    onStatus(`Rendering... ${message}`);

    const context = activeFfmpegLogProgress;
    if (!context) return;

    const seconds = parseFfmpegTimeSeconds(message);
    if (seconds === null || context.totalDuration <= 0) {
      emitProgress(context.onProgress, context.stage, undefined, true);
      return;
    }

    const local = clampProgress(seconds / context.totalDuration);
    const progress =
      context.rangeStart + (context.rangeEnd - context.rangeStart) * local;
    emitProgress(context.onProgress, context.stage, progress, false);
  });

  // Capture any log lines that look like hard errors so we always have a
  // lastFfmpegErrorLog even for cases where the error event isn't fired.
  // (The @ffmpeg/ffmpeg typings only expose 'log' and 'progress' events.)

  emitLoadStatus(
    onStatus,
    onProgress,
    "Loading FFmpeg core (this may take a moment)...",
  );
  recordFfmpegLog(
    `[FFmpeg load] Environment: ${getFfmpegEnvironmentDiagnostics().join("; ")}`,
  );

  try {
    const coreURL = await toBlobURLWithFallback(
      "ffmpeg-core.js",
      "text/javascript",
      onStatus,
      onProgress,
      "FFmpeg core.js",
    );

    const wasmURL = await toBlobURLWithFallback(
      "ffmpeg-core.wasm",
      "application/wasm",
      onStatus,
      onProgress,
      "FFmpeg core.wasm",
    );

    emitLoadStatus(onStatus, onProgress, "Initializing FFmpeg WASM engine...");
    recordFfmpegLog(
      "[FFmpeg load] Starting ffmpeg.load() with Vite bundled @ffmpeg/ffmpeg default worker",
    );
    const loadStartedAt = Date.now();
    const abortController =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const checkpointTimers = [5_000, 15_000, 30_000, 60_000, 90_000].map(
      (delayMs) =>
        setTimeout(() => {
          const seconds = Math.round((Date.now() - loadStartedAt) / 1000);
          const message =
            `Still initializing FFmpeg WASM engine (${seconds}s elapsed). ` +
            getFfmpegEnvironmentDiagnostics().join("; ");
          recordFfmpegLog(`[FFmpeg load] ${message}`);
          emitLoadStatus(onStatus, onProgress, message);
        }, delayMs),
    );
    try {
      await withTimeout(
        ffmpeg.load({ coreURL, wasmURL }, { signal: abortController?.signal }),
        FFMPEG_LOAD_TIMEOUT_MS,
        "ffmpeg.load()",
        () => abortController?.abort(),
      );
    } finally {
      checkpointTimers.forEach(clearTimeout);
    }
    recordFfmpegLog("[FFmpeg load] ffmpeg.load() completed successfully.");
  } catch (error) {
    const msg = extractErrorMessage(error);
    recordFfmpegLog(`[FFmpeg load] FAILED: ${msg}`);
    clearTrackedLoadingInstance(ffmpeg, true);
    // Show a concise intermediate status so the user knows this attempt failed,
    // but leave the full actionable message to the retry wrapper on final failure.
    onStatus(`FFmpeg load attempt failed: ${msg}`);
    emitProgress(onProgress, "FFmpeg load failed", undefined, true);
    throw new Error(msg);
  }

  clearTrackedLoadingInstance(ffmpeg, false);
  return ffmpeg;
}

export async function ensureFfmpeg(
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;

  // If a load is already in-flight, join it instead of racing to start another.
  if (ffmpegLoadingPromise) {
    emitLoadStatus(
      onStatus,
      onProgress,
      "Waiting for FFmpeg to finish loading...",
    );
    return ffmpegLoadingPromise;
  }

  ffmpegLoadFailed = false;
  // Capture the current generation so stale completions (from a load that was
  // in-flight when resetFFmpegInstance() was called) don't overwrite state.
  const gen = loadGeneration;
  const maxRetries = 3;

  async function attemptWithRetry(): Promise<FFmpeg> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (gen !== loadGeneration) {
        throw new Error("FFmpeg load cancelled by reset");
      }
      try {
        const ffmpeg = await _doLoadFfmpeg(onStatus, onProgress);
        if (attempt > 1) {
          console.log(
            `[FFmpeg load] Succeeded on attempt ${attempt}/${maxRetries}`,
          );
          recordFfmpegLog(
            `[FFmpeg load] Succeeded on attempt ${attempt}/${maxRetries}`,
          );
        }
        return ffmpeg;
      } catch (err) {
        lastError = err as Error;
        const isFinalAttempt = attempt === maxRetries;

        console.error(
          `[FFmpeg load] Attempt ${attempt}/${maxRetries} failed:`,
          lastError.message,
        );
        recordFfmpegLog(
          `[FFmpeg load] Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`,
        );

        if (gen !== loadGeneration) {
          throw new Error("FFmpeg load cancelled by reset");
        }

        if (!isFinalAttempt) {
          const delayMs = Math.pow(2, attempt) * 1000; // exponential backoff: 2s, 4s
          emitLoadStatus(
            onStatus,
            onProgress,
            `FFmpeg load failed — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`,
          );
          console.warn(`[FFmpeg load] Retrying in ${delayMs}ms...`, lastError);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    // All retries exhausted — build a clear, actionable final message.
    const finalMessage = buildFfmpegLoadErrorMessage(
      lastError?.message ?? "unknown error",
      maxRetries,
    );
    onStatus(finalMessage);
    emitProgress(onProgress, "FFmpeg load failed", undefined, true);
    throw new Error(finalMessage);
  }

  ffmpegLoadingPromise = attemptWithRetry().then(
    (ffmpeg) => {
      clearTrackedLoadingInstance(ffmpeg, false);
      // Only apply the result if no reset was issued while we were loading.
      if (gen === loadGeneration) {
        ffmpegInstance = ffmpeg;
        ffmpegLoadingPromise = null;
        ffmpegLoadFailed = false;
      } else {
        terminateFfmpegInstance(ffmpeg, "discarding stale loaded instance");
      }
      return ffmpeg;
    },
    (err) => {
      if (gen === loadGeneration) {
        ffmpegLoadingPromise = null;
        ffmpegLoadFailed = true;
        ffmpegInstance = null;
        fontLoaded = false;
      }
      throw err;
    },
  );

  return ffmpegLoadingPromise;
}

/**
 * Fetch the Roboto Regular TTF font and write it to the FFmpeg virtual filesystem.
 * Called automatically before any render that uses text overlays.
 * Subsequent calls are no-ops once the font is loaded for the current FFmpeg instance.
 */
export async function ensureFont(
  ffmpeg: FFmpeg,
  onStatus: StatusCallback,
): Promise<void> {
  if (fontLoaded) return;
  onStatus("Loading font for text overlays...");
  try {
    const fontData = await fetchFile(FONT_CDN_URL);
    await safeWriteFile(
      ffmpeg,
      FONT_VIRTUAL_NAME,
      fontData,
      "ensureFont write",
    );
    fontLoaded = true;
  } catch (err) {
    // If already a detailed error from safeWrite, rethrow as-is
    if ((err as any).ffmpegLogs) throw err;
    throw new Error(
      `Failed to load font for text overlays: ${(err as Error).message}`,
    );
  }
}

/**
 * Build a single `drawtext=...` filter expression for one TextOverlay.
 * The overlay's text is written to a named temp file to avoid escaping issues.
 */
export function buildDrawtextFilter(overlay: TextOverlay): string {
  if (!isValidFfmpegColor(overlay.fontcolor)) {
    throw new Error(
      `Text overlay "${overlay.text.slice(0, 20)}" has an invalid font color: "${overlay.fontcolor}". ` +
        `Use a named color (e.g. "white"), "#RRGGBB", or "0xRRGGBB".`,
    );
  }
  if (overlay.box && !isValidFfmpegColor(overlay.boxColor)) {
    throw new Error(
      `Text overlay "${overlay.text.slice(0, 20)}" has an invalid box color: "${overlay.boxColor}". ` +
        `Use a named color (e.g. "black@0.5"), "#RRGGBB", or "0xRRGGBB", optionally with "@alpha".`,
    );
  }

  const x = overlay.scrolling
    ? buildScrollXExpression(overlay.scrollSpeed)
    : String(overlay.x);

  const parts: string[] = [
    `fontfile=${FONT_VIRTUAL_NAME}`,
    `textfile=tol_${overlay.id}.txt`,
    `x=${x}`,
    `y=${overlay.y}`,
    `fontsize=${overlay.fontsize}`,
    `fontcolor=${overlay.fontcolor}`,
  ];

  if (overlay.box) {
    parts.push(`box=1`, `boxcolor=${overlay.boxColor}`);
  }

  return `drawtext=${parts.join(":")}`;
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
  const drawtextChain = textOverlays.map(buildDrawtextFilter).join(",");
  const rewritten = filterComplex.replace(/\[vout\]/g, "[vpretext]");
  return `${rewritten};[vpretext]${drawtextChain}[vout]`;
}

/** Write each text overlay's text content to a temp file for drawtext's `textfile=` option. */
export async function writeTextOverlayFiles(
  ffmpeg: FFmpeg,
  textOverlays: TextOverlay[],
): Promise<void> {
  for (const overlay of textOverlays) {
    await safeWriteFile(
      ffmpeg,
      `tol_${overlay.id}.txt`,
      overlay.text,
      "text overlay txt",
    );
  }
}

/** Remove the temp text files written by {@link writeTextOverlayFiles}. */
export async function cleanupTextOverlayFiles(
  ffmpeg: FFmpeg,
  textOverlays: TextOverlay[],
): Promise<void> {
  for (const overlay of textOverlays) {
    try {
      await ffmpeg.deleteFile(`tol_${overlay.id}.txt`);
    } catch {
      /* ignore */
    }
  }
}

// Fast path: copy video streams (no decode/encode) but normalize audio to AAC.
// We process each clip individually rather than using a single concat-demuxer
// pass because the concat demuxer can silently drop audio when any file in the
// list lacks an audio stream, or when clips have inconsistent audio codecs
// (e.g. Opus in WebM vs AAC in MP4).  Processing per-clip mirrors the two-pass
// encode path and is the only reliable way to guarantee audio in the output.
export async function mergeClipsLossless(
  ffmpeg: FFmpeg,
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
        "-i",
        clip.inputName!,
        "-filter_complex",
        `${videoFilter};${audioFilter}`,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        ...encodeTail,
      ];
      silentAudioArgs = [
        "-i",
        clip.inputName!,
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
      primaryArgs = ["-i", clip.inputName!, ...durationArgs, ...codecTail];
      silentAudioArgs = [
        "-i",
        clip.inputName!,
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
      if (!NO_AUDIO_STREAM_RE.test((err as Error).message ?? "")) throw err;
      onStatus(`Clip "${clip.title}" has no audio — adding silence...`);
      await safeExec(
        ffmpeg,
        silentAudioArgs,
        null,
        `Lossless copy clip ${index + 1}/${clips.length} "${clip.title}" (silent audio)`,
      );
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
  ffmpeg: FFmpeg,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  emitProgress(onProgress, "FFmpeg re-encode (two-pass)", 0.12, false);

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
  ffmpeg: FFmpeg,
  clip: Clip,
  index: number,
  total: number,
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  rangeStart: number,
  rangeEnd: number,
): Promise<string> {
  const outName = `intermediate-${index}.mp4`;
  const clipDuration = getClipDuration(clip);

  if (!clipNeedsEffects(clip)) {
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

  // Re-encode path: clip has fades, is audio-only, or is RIFE-processed.
  onStatus(`Pass 1 [${index + 1}/${total}]: Encoding "${clip.title}"...`);
  await safeExec(
    ffmpeg,
    [
      "-i",
      clip.inputName!,
      "-filter_complex",
      buildSingleClipFilter(clip),
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
  ffmpeg: FFmpeg,
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
  ffmpeg: FFmpeg,
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  filterComplex: string,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
  textOverlays: TextOverlay[] = [],
): Promise<void> {
  onStatus("Building transition render...");
  emitProgress(onProgress, "FFmpeg transition render", 0.15, false);

  let effectiveFilterComplex = filterComplex;
  if (textOverlays.length > 0) {
    await ensureFont(ffmpeg, onStatus);
    await writeTextOverlayFiles(ffmpeg, textOverlays);
    effectiveFilterComplex = appendTextOverlayFilters(filterComplex, textOverlays);
  }

  const inputArgs: string[] = [];
  for (const clip of clips) {
    inputArgs.push("-i", clip.inputName!);
  }

  try {
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
  } finally {
    if (textOverlays.length > 0) {
      await cleanupTextOverlayFiles(ffmpeg, textOverlays);
    }
  }
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
  if (!ffmpegInstance) return;
  try {
    if (onStatus) onStatus("Cleaning up FFmpeg temporary files...");
    const files = await ffmpegInstance.listDir("/");
    for (const entry of files) {
      if (!entry.isDir) {
        try {
          await ffmpegInstance.deleteFile(entry.name);
        } catch {
          /* ignore individual file deletion errors */
        }
      }
    }
    if (onStatus) onStatus("FFmpeg temporary files cleaned up.");
  } catch (err) {
    // Log but don't throw — cleanup failures shouldn't crash the app
    console.warn("Error during aggressive FFmpeg cleanup:", err);
  }
}

/**
 * Reset the FFmpeg instance entirely, terminating the current instance
 * and forcing a fresh initialization on the next render.
 * This is a nuclear option for freeing all FFmpeg-related memory.
 * Useful when the instance encounters errors or memory pressure is too high.
 */
export async function resetFFmpegInstance(): Promise<void> {
  loadGeneration++;
  if (ffmpegInstance) {
    try {
      // Attempt to clean up VFS first
      await aggressiveCleanupFFmpegVFS();
    } catch {
      /* ignore */
    }

    // Clear the instance reference; it will be garbage collected and a new one
    // will be created on the next ensureFfmpeg() call.
    terminateFfmpegInstance(ffmpegInstance, "resetting loaded instance");
    ffmpegInstance = null;
  }

  if (ffmpegLoadingInstance) {
    terminateFfmpegInstance(ffmpegLoadingInstance, "resetting in-flight load");
    ffmpegLoadingInstance = null;
  }

  ffmpegLoadingPromise = null;
  ffmpegLoadFailed = false;
  fontLoaded = false;
}

/**
 * Regex patterns that indicate the source file has no extractable audio
 * stream, used to convert the generic FFmpeg error into a user-friendly
 * message.
 */
export const NO_AUDIO_STREAM_RE =
  /matches no streams|does not contain|no audio|Output file does not contain|Invalid audio stream/i;
