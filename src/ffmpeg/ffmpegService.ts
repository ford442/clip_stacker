import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { Clip, ExportSettings, ClipTransition, TextOverlay, RenderPlan } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import { getClipDuration } from '../utils/project';
import { buildTransitionFilterComplex } from '../utils/transitions';

const DEFAULT_VIDEO_SIZE = '1280x720';
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const PASS1_PROGRESS_START = 0.12;
const PASS1_PROGRESS_END = 0.85;

/**
 * CDN URL for Roboto Regular TTF.
 * FFmpeg WASM has no system fonts, so we fetch this at render time and write
 * it to the virtual filesystem as 'roboto.ttf'.
 */
const FONT_CDN_URL =
  'https://cdn.jsdelivr.net/gh/google/fonts@main/apache/roboto/static/Roboto-Regular.ttf';
const FONT_VIRTUAL_NAME = 'roboto.ttf';

let ffmpegInstance: FFmpeg | null = null;
let fontLoaded = false;
let ffmpegLoadingInstance: FFmpeg | null = null;

/**
 * In-flight promise for an ongoing ensureFfmpeg() call.
 * Subsequent callers await this same promise instead of racing to create
 * a second FFmpeg instance.
 */
let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;

/** True if the last load attempt failed; cleared on a successful load. */
let ffmpegLoadFailed = false;

/**
 * Monotonically increasing counter, bumped on every resetFFmpegInstance() call.
 * Used to prevent a stale in-flight load from overwriting the state after a
 * reset has already been issued.
 */
let loadGeneration = 0;

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

interface FfmpegLogProgressContext {
  stage: string;
  totalDuration: number;
  rangeStart: number;
  rangeEnd: number;
  onProgress?: ProgressCallback;
}

let activeFfmpegLogProgress: FfmpegLogProgressContext | null = null;

/** Ring buffer of the most recent FFmpeg log messages (for diagnostics on failure). */
const MAX_LOG_BUFFER = 300;
let ffmpegLogBuffer: string[] = [];
let lastFfmpegErrorLog: string | null = null;

/** Append a log line to the diagnostic buffer and detect obvious error patterns. */
function recordFfmpegLog(message: string): void {
  ffmpegLogBuffer.push(message);
  if (ffmpegLogBuffer.length > MAX_LOG_BUFFER) {
    ffmpegLogBuffer.shift();
  }
  // Capture the last line that looks like a hard failure for quick access.
  if (/error|failed|invalid|no such|cannot|unable|does not contain|matches no streams|Output file does not/i.test(message)) {
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
function buildDetailedError(operation: string, originalError: unknown): Error {
  const recent = getLastFfmpegLogs(25).join('\n');
  const errMsg = (originalError as Error)?.message || String(originalError);
  const lastErr = lastFfmpegErrorLog ? `\nLast relevant FFmpeg log: ${lastFfmpegErrorLog}` : '';
  const full = `${operation} failed: ${errMsg}${lastErr}\n\n--- Recent FFmpeg logs (last 25) ---\n${recent || '(no logs captured)'}\n--- End FFmpeg logs ---`;
  const e = new Error(full);
  (e as any).ffmpegLogs = getLastFfmpegLogs(50);
  (e as any).lastFfmpegError = lastFfmpegErrorLog;
  return e;
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress));
}

function emitProgress(
  onProgress: ProgressCallback | undefined,
  stage: string,
  progress?: number,
  indeterminate = false,
): void {
  if (!onProgress) return;
  onProgress({
    stage,
    progress: typeof progress === 'number' ? clampProgress(progress) : undefined,
    indeterminate: indeterminate || typeof progress !== 'number',
  });
}

function emitLoadStatus(
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  stage: string,
): void {
  onStatus(stage);
  emitProgress(onProgress, stage, undefined, true);
}

function getCdnLabel(baseURL: string): string {
  if (baseURL.includes('cdn.jsdelivr.net')) return 'jsDelivr CDN';
  if (baseURL.includes('unpkg.com')) return 'unpkg CDN';
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}

function terminateFfmpegInstance(ffmpeg: FFmpeg | null, context: string): void {
  if (!ffmpeg) return;
  try {
    ffmpeg.terminate();
  } catch (error) {
    console.warn(`Failed to terminate FFmpeg during ${context}:`, error);
  }
}

function clearTrackedLoadingInstance(ffmpeg: FFmpeg, terminate = false): void {
  if (ffmpegLoadingInstance !== ffmpeg) return;
  ffmpegLoadingInstance = null;
  if (terminate) {
    terminateFfmpegInstance(ffmpeg, 'load cleanup');
  }
}

function buildFfmpegLoadErrorMessage(message: string, attempts = 1): string {
  const prefix =
    attempts > 1
      ? `FFmpeg failed to load after ${attempts} attempts. `
      : 'FFmpeg failed to initialize. ';
  return (
    prefix +
    'The browser could not download or start the FFmpeg WebAssembly core. ' +
    'Check your network connection, try "Retry FFmpeg load", or refresh the page. ' +
    `Details: ${message}`
  );
}

function parseFfmpegTimeSeconds(message: string): number | null {
  const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** Safe wrapper around exec that always augments rejection with recent logs + context. */
async function safeExec(
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
async function safeWriteFile(
  ffmpeg: FFmpeg,
  name: string,
  data: Uint8Array | string,
  operation = 'writeFile',
): Promise<void> {
  try {
    await ffmpeg.writeFile(name, data as any);
  } catch (err) {
    throw buildDetailedError(`${operation} ${name}`, err);
  }
}

/** Safe readFile with diagnostics. */
async function safeReadFile(ffmpeg: FFmpeg, name: string, operation = 'readFile'): Promise<Uint8Array> {
  try {
    return (await ffmpeg.readFile(name)) as Uint8Array;
  } catch (err) {
    throw buildDetailedError(`${operation} ${name}`, err);
  }
}

async function execWithFfmpegProgress(
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

function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === 'audio') return true;
  return clip.videoFadeIn > 0 || clip.videoFadeOut > 0 || clip.audioFadeIn > 0 || clip.audioFadeOut > 0;
}

function getSafeExtension(fileName: string, defaultExtension: string): string {
  const match = /\.([^.]+)$/.exec(fileName);
  const raw = match?.[1]?.toLowerCase();
  return raw && /^[a-z0-9]+$/.test(raw) ? raw : defaultExtension;
}

function buildSingleClipFilter(clip: Clip): string {
  const duration = getClipDuration(clip);
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const safeVideoOut = Math.max(0, duration - clip.videoFadeOut);
  const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);
  const parts: string[] = [];

  if (clip.kind === 'video') {
    let v = `[0:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS`;
    if (clip.videoFadeIn > 0) v += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
    if (clip.videoFadeOut > 0) v += `,fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut}`;
    parts.push(`${v}[vout]`);

    let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0) a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    parts.push(`${a}[aout]`);
  } else {
    // Synthesize a black video track for audio-only clips.
    parts.push(`color=c=black:s=${DEFAULT_VIDEO_SIZE}:d=${duration}[vsrc]`);
    let v = `[vsrc]`;
    if (clip.videoFadeIn > 0) v += `fade=t=in:st=0:d=${clip.videoFadeIn},`;
    if (clip.videoFadeOut > 0) v += `fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut},`;
    parts.push(`${v}format=yuv420p[vout]`);

    let a = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0) a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    parts.push(`${a}[aout]`);
  }

  return parts.join(';');
}

/** CDN candidates for @ffmpeg/core@0.12.6 UMD assets, tried in order. */
const FFMPEG_CORE_CDNS = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
];

/** Timeout (ms) for downloading each FFmpeg core asset before trying another source. */
const FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS = 45_000;

/** Timeout (ms) for the entire ffmpeg.load() call including WASM compilation. */
const FFMPEG_LOAD_TIMEOUT_MS = 120_000; // 2 minutes

export function getFfmpegEnvironmentDiagnostics(): string[] {
  const lines: string[] = [];
  const globalScope = globalThis as typeof globalThis & {
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: typeof SharedArrayBuffer;
  };

  lines.push(`location=${typeof window !== 'undefined' ? window.location.href : 'n/a'}`);
  lines.push(`protocol=${typeof window !== 'undefined' ? window.location.protocol : 'n/a'}`);
  lines.push(`crossOriginIsolated=${globalScope.crossOriginIsolated === true}`);
  lines.push(`Worker=${typeof Worker !== 'undefined'}`);
  lines.push(`WebAssembly=${typeof WebAssembly !== 'undefined'}`);
  lines.push(`SharedArrayBuffer=${typeof globalScope.SharedArrayBuffer !== 'undefined'}`);
  lines.push(`hardwareConcurrency=${typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 'unknown' : 'n/a'}`);
  lines.push('ffmpegClassWorkerURL=Vite bundled @ffmpeg/ffmpeg default worker');

  return lines;
}

/**
 * Attempt to fetch a URL as a blob URL, retrying up to maxRetries times with
 * exponential backoff.  Status updates are sent via onStatus so the user sees
 * granular progress.
 */
async function toBlobURLWithRetry(
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
        const suffix = attempt > 1 ? ` (attempt ${attempt}/${maxRetries})` : '';
        emitLoadStatus(onStatus, onProgress, `Downloading ${label}${suffix}...`);
      }
      return await withTimeout(
        toBlobURL(url, mimeType),
        FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
        `Downloading ${label ?? url}`,
      );
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to load ${url} after ${maxRetries} retries: ${(error as Error).message}`);
      }
      const delayMs = Math.pow(2, attempt) * 1000; // exponential backoff: 2s, 4s
      console.warn(
        `Failed to load ${url} (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`,
        error,
      );
      recordFfmpegLog(`[FFmpeg load] Download failed for ${url} (attempt ${attempt}): ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // TypeScript requires this for control flow analysis: while we know the loop either returns
  // or throws on the final attempt, TypeScript can't verify this without an explicit statement here.
  throw new Error('toBlobURLWithRetry: Unexpected - loop should always return or throw');
}

/**
 * Try each CDN in FFMPEG_CORE_CDNS until one succeeds.  This provides resilience
 * against individual CDN outages.
 */
async function toBlobURLWithFallback(
  filename: string,
  mimeType: string,
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  label: string,
): Promise<string> {
  let lastError: Error | null = null;
  for (const [index, baseURL] of FFMPEG_CORE_CDNS.entries()) {
    const url = `${baseURL}/${filename}`;
    const cdnLabel = getCdnLabel(baseURL);
    try {
      return await toBlobURLWithRetry(url, mimeType, onStatus, onProgress, `${label} from ${cdnLabel}`);
    } catch (err) {
      lastError = err as Error;
      recordFfmpegLog(`[FFmpeg load] CDN ${baseURL} failed for ${filename}: ${lastError.message}`);
      console.warn(`[FFmpeg load] CDN ${baseURL} failed for ${filename}, trying next CDN...`);
      if (index < FFMPEG_CORE_CDNS.length - 1) {
        emitLoadStatus(
          onStatus,
          onProgress,
          `${cdnLabel} failed for ${label}. Trying the next FFmpeg CDN...`,
        );
      }
    }
  }
  throw new Error(
    `Failed to download ${filename} from all CDNs. Last error: ${lastError?.message ?? 'unknown'}`,
  );
}

/**
 * Race a promise against a timeout.  Throws if the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
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

async function _doLoadFfmpeg(onStatus: StatusCallback, onProgress?: ProgressCallback): Promise<FFmpeg> {
  // Reset font state whenever a new FFmpeg instance is created.
  fontLoaded = false;

  const ffmpeg = new FFmpeg();
  ffmpegLoadingInstance = ffmpeg;

  // CRITICAL: capture EVERY log line. The old filter silently dropped all errors/warnings.
  ffmpeg.on('log', ({ message }) => {
    recordFfmpegLog(message);
    // Always surface to console for developers (was completely invisible before).
    console.log('[FFmpeg]', message);

    // Only drive progress/status from time= lines (keep UX clean).
    if (!message.includes('time=')) return;
    onStatus(`Rendering... ${message}`);

    const context = activeFfmpegLogProgress;
    if (!context) return;

    const seconds = parseFfmpegTimeSeconds(message);
    if (seconds === null || context.totalDuration <= 0) {
      emitProgress(context.onProgress, context.stage, undefined, true);
      return;
    }

    const local = clampProgress(seconds / context.totalDuration);
    const progress = context.rangeStart + (context.rangeEnd - context.rangeStart) * local;
    emitProgress(context.onProgress, context.stage, progress, false);
  });

  // Capture any log lines that look like hard errors so we always have a
  // lastFfmpegErrorLog even for cases where the error event isn't fired.
  // (The @ffmpeg/ffmpeg typings only expose 'log' and 'progress' events.)

  emitLoadStatus(onStatus, onProgress, 'Loading FFmpeg core (this may take a moment)...');
  recordFfmpegLog(`[FFmpeg load] Environment: ${getFfmpegEnvironmentDiagnostics().join('; ')}`);

  try {
    const coreURL = await toBlobURLWithFallback(
      'ffmpeg-core.js',
      'text/javascript',
      onStatus,
      onProgress,
      'FFmpeg core.js',
    );

    const wasmURL = await toBlobURLWithFallback(
      'ffmpeg-core.wasm',
      'application/wasm',
      onStatus,
      onProgress,
      'FFmpeg core.wasm',
    );

    emitLoadStatus(onStatus, onProgress, 'Initializing FFmpeg WASM engine...');
    recordFfmpegLog('[FFmpeg load] Starting ffmpeg.load() with Vite bundled @ffmpeg/ffmpeg default worker');
    const loadStartedAt = Date.now();
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const checkpointTimers = [5_000, 15_000, 30_000, 60_000, 90_000].map((delayMs) =>
      setTimeout(() => {
        const seconds = Math.round((Date.now() - loadStartedAt) / 1000);
        const message =
          `Still initializing FFmpeg WASM engine (${seconds}s elapsed). ` +
          getFfmpegEnvironmentDiagnostics().join('; ');
        recordFfmpegLog(`[FFmpeg load] ${message}`);
        emitLoadStatus(onStatus, onProgress, message);
      }, delayMs),
    );
    try {
      await withTimeout(
        ffmpeg.load({ coreURL, wasmURL }, { signal: abortController?.signal }),
        FFMPEG_LOAD_TIMEOUT_MS,
        'ffmpeg.load()',
        () => abortController?.abort(),
      );
    } finally {
      checkpointTimers.forEach(clearTimeout);
    }
    recordFfmpegLog('[FFmpeg load] ffmpeg.load() completed successfully.');
  } catch (error) {
    const msg = (error as Error).message;
    recordFfmpegLog(`[FFmpeg load] FAILED: ${msg}`);
    clearTrackedLoadingInstance(ffmpeg, true);
    // Show a concise intermediate status so the user knows this attempt failed,
    // but leave the full actionable message to the retry wrapper on final failure.
    onStatus(`FFmpeg load attempt failed: ${msg}`);
    emitProgress(onProgress, 'FFmpeg load failed', undefined, true);
    throw new Error(msg);
  }

  clearTrackedLoadingInstance(ffmpeg, false);
  return ffmpeg;
}

export async function ensureFfmpeg(onStatus: StatusCallback, onProgress?: ProgressCallback): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;

  // If a load is already in-flight, join it instead of racing to start another.
  if (ffmpegLoadingPromise) {
    emitLoadStatus(onStatus, onProgress, 'Waiting for FFmpeg to finish loading...');
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
        throw new Error('FFmpeg load cancelled by reset');
      }
      try {
        const ffmpeg = await _doLoadFfmpeg(onStatus, onProgress);
        if (attempt > 1) {
          console.log(`[FFmpeg load] Succeeded on attempt ${attempt}/${maxRetries}`);
          recordFfmpegLog(`[FFmpeg load] Succeeded on attempt ${attempt}/${maxRetries}`);
        }
        return ffmpeg;
      } catch (err) {
        lastError = err as Error;
        const isFinalAttempt = attempt === maxRetries;

        console.error(`[FFmpeg load] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
        recordFfmpegLog(`[FFmpeg load] Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`);

        if (gen !== loadGeneration) {
          throw new Error('FFmpeg load cancelled by reset');
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
    const finalMessage = buildFfmpegLoadErrorMessage(lastError?.message ?? 'unknown error', maxRetries);
    onStatus(finalMessage);
    emitProgress(onProgress, 'FFmpeg load failed', undefined, true);
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
        terminateFfmpegInstance(ffmpeg, 'discarding stale loaded instance');
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
async function ensureFont(ffmpeg: FFmpeg, onStatus: StatusCallback): Promise<void> {
  if (fontLoaded) return;
  onStatus('Loading font for text overlays...');
  try {
    const fontData = await fetchFile(FONT_CDN_URL);
    await safeWriteFile(ffmpeg, FONT_VIRTUAL_NAME, fontData, 'ensureFont write');
    fontLoaded = true;
  } catch (err) {
    // If already a detailed error from safeWrite, rethrow as-is
    if ((err as any).ffmpegLogs) throw err;
    throw new Error(`Failed to load font for text overlays: ${(err as Error).message}`);
  }
}

/**
 * Build a single `drawtext=...` filter expression for one TextOverlay.
 * The overlay's text is written to a named temp file to avoid escaping issues.
 */
function buildDrawtextFilter(overlay: TextOverlay): string {
  const x = overlay.scrolling
    ? `w+tw-(t*${overlay.scrollSpeed})`
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

  return `drawtext=${parts.join(':')}`;
}


// Lossless path: all clips are clean video — use the concat demuxer with -c copy.
async function mergeClipsLossless(
  ffmpeg: FFmpeg,
  clips: Clip[],
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<void> {
  const listLines = clips.map((clip) => {
    const lines = [`file '${clip.inputName}'`];
    if (clip.trimStart > 0) lines.push(`inpoint ${clip.trimStart}`);
    if (Number.isFinite(clip.trimEnd)) lines.push(`outpoint ${clip.trimEnd}`);
    return lines.join('\n');
  });
  await safeWriteFile(ffmpeg, 'concat_list.txt', listLines.join('\n'), 'lossless concat list');

  onStatus('FFmpeg path: lossless concat (stream copy).');
  emitProgress(onProgress, 'FFmpeg lossless concat', 0.25, false);
  await safeExec(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', 'stacked.mp4'], null, 'Lossless concat exec');
  emitProgress(onProgress, 'FFmpeg lossless concat', 0.9, false);
  try { await ffmpeg.deleteFile('concat_list.txt'); } catch { /* ignore */ }
}

// Perform two-pass re-encoding for clips with effects
async function performTwoPassEncode(
  ffmpeg: FFmpeg,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  emitProgress(onProgress, 'FFmpeg re-encode (two-pass)', 0.12, false);
  await new Promise((r) => setTimeout(r, 1500));

  const intermediates: string[] = [];
  const pass1TotalDuration = clips.reduce((sum, clip) => sum + getClipDuration(clip), 0);
  let pass1ElapsedDuration = 0;
  for (const [index, clip] of clips.entries()) {
    const clipDuration = getClipDuration(clip);
    const localStart = pass1TotalDuration > 0 ? pass1ElapsedDuration / pass1TotalDuration : index / clips.length;
    const localEnd = pass1TotalDuration > 0 ? (pass1ElapsedDuration + clipDuration) / pass1TotalDuration : (index + 1) / clips.length;
    const rangeStart = PASS1_PROGRESS_START + localStart * (PASS1_PROGRESS_END - PASS1_PROGRESS_START);
    const rangeEnd = PASS1_PROGRESS_START + localEnd * (PASS1_PROGRESS_END - PASS1_PROGRESS_START);
    intermediates.push(await processClipPass1(
      ffmpeg,
      clip,
      index,
      clips.length,
      settings,
      onStatus,
      onProgress,
      rangeStart,
      rangeEnd,
    ));
    pass1ElapsedDuration += clipDuration;
  }
  await mergeClipsPass2(ffmpeg, intermediates, onStatus, totalDuration, onProgress);
}

// Pass 1: produce one intermediate mp4 per clip.
async function processClipPass1(
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

  if (clipNeedsEffects(clip)) {
    onStatus(`Pass 1 [${index + 1}/${total}]: Encoding "${clip.title}"...`);
    await safeExec(ffmpeg, [
      '-i', clip.inputName!,
      '-filter_complex', buildSingleClipFilter(clip),
      '-map', '[vout]',
      '-map', '[aout]',
      '-r', '30',
      '-c:v', 'libx264',
      '-crf', String(settings.crf),
      '-preset', settings.preset,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      outName,
    ], {
      stage: `Pass 1: ${clip.title}`,
      totalDuration: clipDuration,
      rangeStart,
      rangeEnd,
      onProgress,
    }, `Pass 1 encode for clip ${index + 1}/${total} "${clip.title}"`);
  } else {
    // -ss before -i triggers a fast container-level seek; -t is duration from that point.
    onStatus(`Pass 1 [${index + 1}/${total}]: Trimming "${clip.title}" (lossless)...`);
    const args: string[] = [];
    if (clip.trimStart > 0) args.push('-ss', String(clip.trimStart));
    args.push('-i', clip.inputName!);
    if (Number.isFinite(clip.trimEnd)) args.push('-t', String(clip.trimEnd - clip.trimStart));
    args.push('-c', 'copy', outName);
    await safeExec(ffmpeg, args, null, `Pass 1 trim (lossless copy) for clip ${index + 1}/${total} "${clip.title}"`);
    emitProgress(onProgress, `Pass 1: ${clip.title}`, rangeEnd, false);
  }

  return outName;
}

// Pass 2: concatenate all intermediate files produced by Pass 1.
async function mergeClipsPass2(
  ffmpeg: FFmpeg,
  intermediateNames: string[],
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  const concatList = intermediateNames.map((n) => `file '${n}'`).join('\n');
  await safeWriteFile(ffmpeg, 'concat_list.txt', concatList, 'pass2 concat list');

  onStatus('Pass 2: Final concatenation...');
  await safeExec(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', 'stacked.mp4'], {
    stage: 'Pass 2: Final concatenation',
    totalDuration,
    rangeStart: 0.85,
    rangeEnd: 0.95,
    onProgress,
  }, 'Pass 2 final concat exec');

  try { await ffmpeg.deleteFile('concat_list.txt'); } catch { /* ignore */ }
  for (const name of intermediateNames) {
    await ffmpeg.deleteFile(name);
  }
}

/** Render all clips using a single filter_complex with xfade/acrossfade transitions. */
async function mergeClipsWithTransitions(
  ffmpeg: FFmpeg,
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  filterComplex: string,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  onStatus('Building transition render...');
  emitProgress(onProgress, 'FFmpeg transition render', 0.15, false);

  const inputArgs: string[] = [];
  for (const clip of clips) {
    inputArgs.push('-i', clip.inputName!);
  }

  await safeExec(ffmpeg, [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-r', '30',
    '-c:v', 'libx264',
    '-crf', String(settings.crf),
    '-preset', settings.preset,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    'stacked.mp4',
  ], {
    stage: 'FFmpeg transition render',
    totalDuration,
    rangeStart: 0.15,
    rangeEnd: 0.95,
    onProgress,
  }, 'Transition filter_complex render');
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
export function buildPipFilterComplex(clips: Clip[]): string {
  const parts: string[] = [];

  // ── Phase 1: per-clip pre-processing ────────────────────────────────────────
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const dur = getClipDuration(clip);
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const isBase = (clip.layerIndex ?? 0) === 0;
    const safeVOut = Math.max(0, dur - clip.videoFadeOut);
    const safeAOut = Math.max(0, dur - clip.audioFadeOut);

    if (clip.kind === 'video') {
      let vf = `[${i}:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS`;

      if (isBase) {
        // Normalise to output canvas size
        vf += `,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`;
        vf += `,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
      } else {
        // Scale overlay to requested dimensions (0 means keep original)
        const w = clip.width ?? 0;
        const h = clip.height ?? 0;
        if (w > 0 && h > 0) {
          vf += `,scale=${w}:${h}`;
        } else if (w > 0) {
          vf += `,scale=${w}:-2`;
        } else if (h > 0) {
          vf += `,scale=-2:${h}`;
        }
        // Apply opacity when < 1
        const opacity = clip.opacity ?? 1;
        if (opacity < 1) {
          vf += `,format=rgba,colorchannelmixer=aa=${opacity.toFixed(4)}`;
        }
      }

      if (clip.videoFadeIn > 0) vf += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
      if (clip.videoFadeOut > 0) vf += `,fade=t=out:st=${safeVOut}:d=${clip.videoFadeOut}`;
      parts.push(`${vf}[v${i}]`);
    } else {
      // Audio-only: synthesise a black video track
      parts.push(`color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:d=${dur},format=yuv420p[v${i}]`);
    }

    // Audio
    let af = `[${i}:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) af += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0) af += `,afade=t=out:st=${safeAOut}:d=${clip.audioFadeOut}`;
    parts.push(`${af}[a${i}]`);
  }

  // ── Phase 2: concatenate base-layer clips ────────────────────────────────────
  const baseIndices = clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.layerIndex ?? 0) === 0)
    .map(({ i }) => i);

  if (baseIndices.length === 0) {
    throw new Error('PiP compositing requires at least one base-layer clip (layerIndex = 0).');
  }

  let currentV: string;
  let baseAudio: string;

  if (baseIndices.length === 1) {
    currentV = `v${baseIndices[0]}`;
    baseAudio = `a${baseIndices[0]}`;
  } else {
    // concat expects interleaved [v0][a0][v1][a1]...
    const segInputs = baseIndices.map((i) => `[v${i}][a${i}]`).join('');
    parts.push(`${segInputs}concat=n=${baseIndices.length}:v=1:a=1[vbase][abase]`);
    currentV = 'vbase';
    baseAudio = 'abase';
  }

  // ── Phase 3: overlay each PiP clip in layerIndex order ──────────────────────
  const overlayEntries = clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.layerIndex ?? 0) > 0)
    .sort((a, b) => (a.c.layerIndex ?? 0) - (b.c.layerIndex ?? 0));

  const audioStreams: string[] = [baseAudio];

  for (let o = 0; o < overlayEntries.length; o++) {
    const { c: clip, i: idx } = overlayEntries[o];
    const x = clip.x ?? 0;
    const y = clip.y ?? 0;
    const isLast = o === overlayEntries.length - 1;
    const outV = isLast ? 'vout' : `vcomp${o}`;

    parts.push(`[${currentV}][v${idx}]overlay=${x}:${y}:eof_action=pass[${outV}]`);
    currentV = outV;
    audioStreams.push(`a${idx}`);
  }

  // When there are no overlay clips the base video is already the final output
  if (overlayEntries.length === 0) {
    parts.push(`[${currentV}]null[vout]`);
  }

  // ── Phase 4: mix audio ───────────────────────────────────────────────────────
  if (audioStreams.length === 1) {
    parts.push(`[${audioStreams[0]}]anull[aout]`);
  } else {
    const audioInputs = audioStreams.map((s) => `[${s}]`).join('');
    parts.push(`${audioInputs}amix=inputs=${audioStreams.length}:normalize=0[aout]`);
  }

  return parts.join(';');
}

/** Render all clips using a filter_complex that composites PiP/overlay layers. */
async function mergeClipsWithCompositing(
  ffmpeg: FFmpeg,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  onStatus('Building PiP/compositing render...');
  emitProgress(onProgress, 'FFmpeg PiP/compositing render', 0.15, false);

  const filterComplex = buildPipFilterComplex(clips);

  const inputArgs: string[] = [];
  for (const clip of clips) {
    inputArgs.push('-i', clip.inputName!);
  }

  await safeExec(ffmpeg, [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-r', '30',
    '-c:v', 'libx264',
    '-crf', String(settings.crf),
    '-preset', settings.preset,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    'stacked.mp4',
  ], {
    stage: 'FFmpeg PiP/compositing render',
    totalDuration,
    rangeStart: 0.15,
    rangeEnd: 0.95,
    onProgress,
  }, 'PiP/compositing filter_complex render');
}

/**
 * Minimum size in bytes for a non-empty WAV file (44-byte RIFF header + at
 * least one sample).  An output at or below this threshold means FFmpeg ran
 * without error but produced no audio data — treated as a "no audio stream"
 * failure.
 */
export const WAV_HEADER_MIN_BYTES = 45;

/**
 * Regex patterns that indicate the source file has no extractable audio
 * stream, used to convert the generic FFmpeg error into a user-friendly
 * message.
 */
export const NO_AUDIO_STREAM_RE =
  /matches no streams|does not contain|no audio|Output file does not contain|Invalid audio stream/i;

/**
 * Pre-flight validation for extractAudioToWav.
 * Returns null on success, or an error message string if validation fails.
 * Exported for unit testing.
 */
export function validateExtractAudioClip(clip: Clip): string | null {
  const rawDur = (Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration) - clip.trimStart;
  if (rawDur <= 0) {
    return (
      `Cannot extract audio: clip "${clip.title}" has zero or negative duration after trim ` +
      `(trimStart=${clip.trimStart}, trimEnd=${Number.isFinite(clip.trimEnd) ? clip.trimEnd : 'end'}, ` +
      `duration=${clip.duration}).`
    );
  }
  return null;
}

export async function extractAudioToWav(clip: Clip, onStatus: StatusCallback): Promise<Blob> {
  // Pre-flight: fast early validation before loading FFmpeg.
  const preflightError = validateExtractAudioClip(clip);
  if (preflightError) throw new Error(preflightError);

  // Start fresh log capture for this operation so any failure has clean context.
  clearFfmpegLogs();

  const ffmpeg = await ensureFfmpeg(onStatus);

  // For audio-only source files use the actual file extension so FFmpeg can
  // correctly demux (e.g. mp3, aac, ogg).  Fall back to mp4 for video clips.
  const defaultExt = clip.kind === 'audio' ? 'mp3' : 'mp4';
  const ext = getSafeExtension(clip.file.name, defaultExt);
  const inputName = `audio-extract-input.${ext}`;
  const outputName = 'audio-extract-output.wav';

  // Clean up any leftover files from a previous extraction run.
  for (const name of [inputName, outputName]) {
    try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
  }

  onStatus(`Writing "${clip.title}" to FFmpeg…`);

  try {
    await safeWriteFile(ffmpeg, inputName, await fetchFile(clip.file), 'extract write input');

    const args: string[] = [];

    // Seek before input for fast container-level seek when trimStart is set.
    if (clip.trimStart > 0) args.push('-ss', String(clip.trimStart));
    args.push('-i', inputName);
    if (Number.isFinite(clip.trimEnd)) {
      args.push('-t', String(clip.trimEnd - clip.trimStart));
    }

    args.push(
      '-map', '0:a:0',        // explicitly select the first audio stream — gives a clear
                              // "matches no streams" error if the file has no audio
      '-vn',                  // drop video stream (no-op for audio-only files; safe to include)
      '-acodec', 'pcm_s16le', // PCM 16-bit little-endian (WAV)
      '-ar', '44100',         // 44.1 kHz sample rate
      '-ac', '2',             // stereo
      outputName,
    );

    onStatus(`Extracting audio from "${clip.title}"…`);

    try {
      await safeExec(ffmpeg, args, null, `Extract audio exec for "${clip.title}" (trim ${clip.trimStart}-${clip.trimEnd || 'end'})`);
    } catch (execErr) {
      // Intercept "no audio stream" errors and surface a clear user message.
      const msg = (execErr as Error).message;
      if (NO_AUDIO_STREAM_RE.test(msg)) {
        throw new Error(
          `No audio stream found in "${clip.title}". ` +
          `The file may be video-only or use an unsupported audio codec.\n\n${msg}`,
        );
      }
      throw execErr;
    }

    const output = await safeReadFile(ffmpeg, outputName, 'extract read output');

    // A valid WAV file with audio data must be larger than the RIFF header.
    // An empty or header-only output means FFmpeg ran without error but wrote
    // no audio samples — treat this as a silent failure.
    if (output.byteLength <= WAV_HEADER_MIN_BYTES) {
      throw new Error(
        `Audio extraction produced an empty output for "${clip.title}". ` +
        `The clip may contain no audio stream, or the trimmed region contains no audio data.`,
      );
    }

    // Copy to a plain ArrayBuffer so Blob constructor accepts it regardless of
    // whether FFmpeg's backing buffer is a SharedArrayBuffer.
    const plain = new Uint8Array(output).buffer as ArrayBuffer;

    onStatus('Audio extraction complete.');
    return new Blob([plain], { type: 'audio/wav' });
  } catch (err) {
    // Always attempt cleanup on failure path.
    try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }
    // Re-throw the (already detailed) error
    throw err;
  } finally {
    // Best-effort final cleanup even on success path.
    try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }
  }
}

/**
 * Export a trimmed video segment to an MP4 blob using lossless stream copy.
 * Used by the RIFE integration to send the exact trimmed region to the
 * HuggingFace frame-interpolation space (per-clip, before merge).
 */
export async function extractTrimmedVideoClip(clip: Clip, onStatus: StatusCallback): Promise<Blob> {
  clearFfmpegLogs();

  const ffmpeg = await ensureFfmpeg(onStatus);

  const ext = getSafeExtension(clip.file.name, 'mp4');
  const inputName = `rife-input.${ext}`;
  const outputName = 'rife-trimmed.mp4';

  const dur = getClipDuration(clip);
  if (dur <= 0) {
    throw new Error('Cannot extract trimmed clip: clip has zero or negative duration after trim.');
  }

  for (const name of [inputName, outputName]) {
    try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
  }

  onStatus(`Preparing trimmed segment of "${clip.title}" for RIFE…`);

  try {
    await safeWriteFile(ffmpeg, inputName, await fetchFile(clip.file), 'rife trim write input');

    const args: string[] = [];
    if (clip.trimStart > 0) args.push('-ss', String(clip.trimStart));
    args.push('-i', inputName);
    if (Number.isFinite(clip.trimEnd)) {
      args.push('-t', String(clip.trimEnd - clip.trimStart));
    }
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', outputName);

    await safeExec(ffmpeg, args, null, `RIFE trim for "${clip.title}" (${clip.trimStart}-${clip.trimEnd || 'end'})`);

    const output = await safeReadFile(ffmpeg, outputName, 'rife trim read output');
    const plain = new Uint8Array(output).buffer as ArrayBuffer;

    onStatus('Trimmed segment ready.');
    return new Blob([plain], { type: 'video/mp4' });
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }
  }
}

/**
 * Analyze clips, transitions, and overlays to determine which rendering path will be used.
 * Returns a description of the plan and whether re-encoding will occur.
 *
 * Decision logic (in order):
 * 1. If any clip has layerIndex > 0 → PiP/compositing (re-encode)
 * 2. If any transitions are active → transitions path (re-encode)
 * 3. If any text overlays → text overlays path (re-encode)
 * 4. If any clip needs effects (fades or audio-only) → two-pass re-encode
 * 5. Otherwise → lossless concat (fast, no quality loss)
 */
export function calculateRenderPlan(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  textOverlays: TextOverlay[] = [],
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): RenderPlan {
  // Check for PiP clips
  const hasPipClips = clips.some((c) => (c.layerIndex ?? 0) > 0);
  if (hasPipClips) {
    return {
      path: 'pip',
      reason: 'Picture-in-Picture compositing detected',
      willReencode: true,
      description: 'Re-encoding with PiP compositing (re-encode)',
    };
  }

  // Check for transitions
  const activeTransitions = transitions.filter((t) => t.type !== 'none' && t.duration > 0);
  if (activeTransitions.length > 0) {
    return {
      path: 'transitions',
      reason: `${activeTransitions.length} transition${activeTransitions.length > 1 ? 's' : ''} enabled`,
      willReencode: true,
      description: 'Re-encoding with transitions (re-encode)',
    };
  }

  // Check for text overlays
  if (textOverlays.length > 0) {
    return {
      path: 'textoverlays',
      reason: `${textOverlays.length} text overlay${textOverlays.length > 1 ? 's' : ''} present`,
      willReencode: true,
      description: 'Re-encoding with text overlays (re-encode)',
    };
  }

  // Check for clips that need effects
  const effectClips = clips.filter(clipNeedsEffects);
  if (effectClips.length > 0) {
    // Count audio and fade clips in a single pass
    let audioClipCount = 0;
    let fadeClipCount = 0;
    for (const clip of effectClips) {
      if (clip.kind === 'audio') {
        audioClipCount++;
      } else if (clip.videoFadeIn > 0 || clip.videoFadeOut > 0 || clip.audioFadeIn > 0 || clip.audioFadeOut > 0) {
        fadeClipCount++;
      }
    }
    
    let reasonDetail = '';
    if (audioClipCount > 0 && fadeClipCount > 0) {
      reasonDetail = 'have fades and/or are audio-only';
    } else if (audioClipCount > 0) {
      reasonDetail = `${audioClipCount > 1 ? 'are' : 'is'} audio-only`;
    } else {
      reasonDetail = `${fadeClipCount > 1 ? 'have' : 'has'} fades`;
    }
    
    const titles = effectClips.map((c) => `"${c.title}"`).join(', ');
    return {
      path: 'effects-reencoding',
      reason: `${effectClips.length > 1 ? 'Clips' : 'Clip'} ${titles} ${reasonDetail}`,
      willReencode: true,
      description: `Re-encoding ${titles} with CRF ${settings.crf} (${settings.preset} preset)`,
    };
  }

  // All clips are clean video with no effects
  return {
    path: 'lossless-concat',
    reason: 'All clips are clean video with no effects',
    willReencode: false,
    description: 'Lossless concat (fast, no quality loss)',
  };
}

export async function mergeClips(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
  onStatus: StatusCallback,
  textOverlays: TextOverlay[] = [],
  onProgress?: ProgressCallback,
  forceReencode = false,
): Promise<Blob> {
  // Fresh diagnostic buffer for this render so failure messages are relevant.
  clearFfmpegLogs();

  if (clips.length === 0) throw new Error('Upload clips before rendering.');
  const totalDuration = clips.reduce((sum, clip) => sum + getClipDuration(clip), 0);

  const ffmpeg = await ensureFfmpeg(onStatus, onProgress);
  onStatus('Preparing media...');
  emitProgress(onProgress, 'Preparing media', 0.02, false);

  // Clean up leftover files from a previous run.
  for (const entry of await ffmpeg.listDir('/')) {
    if (entry.isDir) continue;
    if (
      entry.name.startsWith('input-') ||
      entry.name.startsWith('intermediate-') ||
      entry.name.startsWith('tol_') ||
      entry.name === 'stacked.mp4' ||
      entry.name === 'stacked_final.mp4' ||
      entry.name === 'concat_list.txt'
    ) {
      try { await ffmpeg.deleteFile(entry.name); } catch { /* ignore */ }
    }
  }

  // Assign input file names and write to WASM virtual filesystem.
  const workingClips = clips.map((clip, index) => ({
    ...clip,
    inputName: `input-${index}.${getSafeExtension(clip.file.name, clip.kind === 'video' ? 'mp4' : 'mp3')}`,
  }));

  for (const [index, clip] of workingClips.entries()) {
    await safeWriteFile(ffmpeg, clip.inputName!, await fetchFile(clip.file), `write input ${index}`);
    const prepProgress = 0.03 + ((index + 1) / workingClips.length) * 0.09;
    emitProgress(onProgress, 'Preparing media', prepProgress, false);
  }

  const renderPlan = calculateRenderPlan(workingClips, transitions, textOverlays, settings);
  
  // If force re-encode is enabled and we would otherwise use lossless concat, override to re-encode
  let effectivePlan = renderPlan;
  if (forceReencode && renderPlan.path === 'lossless-concat') {
    effectivePlan = {
      path: 'effects-reencoding',
      reason: 'Force re-encode enabled',
      willReencode: true,
      description: `Forced re-encoding (CRF ${settings.crf}, ${settings.preset} preset)`,
    };
  }
  
  onStatus(`Render plan: ${effectivePlan.description} (${effectivePlan.reason})`);

  const activeTransitions = transitions.filter((t) => t.type !== 'none' && t.duration > 0);
  const effectClips = workingClips.filter(clipNeedsEffects);
  const hasPipClips = workingClips.some((c) => (c.layerIndex ?? 0) > 0);
  const transitionFilterComplex =
    activeTransitions.length > 0 ? buildTransitionFilterComplex(workingClips, activeTransitions) : null;

  // If force re-encode is enabled, skip lossless path and go straight to re-encoding
  const shouldForceReencodeNow = forceReencode && renderPlan.path === 'lossless-concat';

  try {
    if (hasPipClips) {
      // PiP / compositing path — overlay clips on top of the base layer
      onStatus(`FFmpeg path: ${effectivePlan.description}`);
      await mergeClipsWithCompositing(ffmpeg, workingClips, settings, onStatus, totalDuration, onProgress);
    } else if (transitionFilterComplex) {
      // Single-pass filter_complex render covering all clips + transitions
      onStatus(`FFmpeg path: ${effectivePlan.description}`);
      await mergeClipsWithTransitions(
        ffmpeg,
        workingClips,
        activeTransitions,
        settings,
        transitionFilterComplex,
        onStatus,
        totalDuration,
        onProgress,
      );
    } else if (shouldForceReencodeNow) {
      // Force re-encode even though lossless would be used
      onStatus(
        `FFmpeg path: ${effectivePlan.description}. Starting export...`,
      );
      await performTwoPassEncode(ffmpeg, workingClips, settings, onStatus, totalDuration, onProgress);
    } else if (effectivePlan.path === 'lossless-concat') {
      // Lossless path (text overlays will be applied afterward if present)
      onStatus(`FFmpeg path: ${effectivePlan.description}`);
      await mergeClipsLossless(ffmpeg, workingClips, onStatus, onProgress);
    } else {
      // Two-pass re-encoding for effects
      onStatus(
        `FFmpeg path: ${effectivePlan.description}. Starting export...`,
      );
      await performTwoPassEncode(ffmpeg, workingClips, settings, onStatus, totalDuration, onProgress);
    }
  } finally {
    // Always clean input files even if a render pass threw.
    for (const clip of workingClips) {
      if (clip.inputName) {
        try { await ffmpeg.deleteFile(clip.inputName); } catch { /* ignore */ }
      }
    }
  }

  // ── Text overlay post-processing ──────────────────────────────────────────
  // Apply drawtext filters on top of the composed stacked.mp4 when overlays exist.
  let finalFileName = 'stacked.mp4';

  if (textOverlays.length > 0) {
    await ensureFont(ffmpeg, onStatus);

    // Write each overlay's text to a dedicated temp file to avoid escaping issues.
    for (const overlay of textOverlays) {
      await safeWriteFile(ffmpeg, `tol_${overlay.id}.txt`, overlay.text, 'text overlay txt');
    }

    const vfFilter = textOverlays.map(buildDrawtextFilter).join(',');
    onStatus('Applying text overlays...');
    emitProgress(onProgress, 'Applying text overlays', 0.95, false);

    await safeExec(ffmpeg, [
      '-i', 'stacked.mp4',
      '-vf', vfFilter,
      '-c:v', 'libx264',
      '-crf', String(settings.crf),
      '-preset', settings.preset,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      'stacked_final.mp4',
    ], {
      stage: 'Applying text overlays',
      totalDuration,
      rangeStart: 0.95,
      rangeEnd: 0.99,
      onProgress,
    }, 'Text overlay drawtext pass');

    // Clean up temp text files.
    for (const overlay of textOverlays) {
      try { await ffmpeg.deleteFile(`tol_${overlay.id}.txt`); } catch { /* ignore */ }
    }

    try { await ffmpeg.deleteFile('stacked.mp4'); } catch { /* ignore */ }
    finalFileName = 'stacked_final.mp4';
  }

  const output = await safeReadFile(ffmpeg, finalFileName, 'final output read');
  try { await ffmpeg.deleteFile(finalFileName); } catch { /* ignore */ }
  // Copy to a plain ArrayBuffer so Blob constructor accepts it regardless of
  // whether FFmpeg's backing buffer is a SharedArrayBuffer.
  const plain = new Uint8Array(output).buffer as ArrayBuffer;
  emitProgress(onProgress, 'Render finalizing', 1, false);
  return new Blob([plain], { type: 'video/mp4' });
}

// ---------------------------------------------------------------------------
// Hybrid pipeline: mux a pre-rendered video blob with clip audio
// ---------------------------------------------------------------------------

/**
 * Mux a pre-rendered video blob (e.g., from MediaRecorder canvas capture) with
 * the audio tracks from the original source clips.
 *
 * This is the final step of the hybrid Canvas/WebGPU rendering pipeline:
 *   Canvas compositing → MediaRecorder capture → muxVideoWithAudio → final MP4
 *
 * Audio from each clip is trimmed, faded (if configured), and concatenated in
 * order before being muxed with the video stream.  The video stream is copied
 * without re-encoding to preserve quality from the capture stage.
 *
 * @param videoBlob  - Video-only blob from the MediaRecorder canvas capture.
 * @param clips      - Original source clips; their audio tracks are extracted and muxed.
 * @param settings   - Export quality settings (used for audio bitrate).
 * @param onStatus   - Status callback for progress messages.
 */
export async function muxVideoWithAudio(
  videoBlob: Blob,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (clips.length === 0) throw new Error('No clips provided for audio muxing.');

  const ffmpeg = await ensureFfmpeg(onStatus, onProgress);
  onStatus('Preparing audio mux...');
  emitProgress(onProgress, 'Audio mux preparation', 0.86, false);

  // Clean up any leftover files from a previous mux run.
  for (const entry of await ffmpeg.listDir('/')) {
    if (entry.isDir) continue;
    if (
      entry.name.startsWith('mux_audio_') ||
      entry.name === 'mux_canvas_video.mp4' ||
      entry.name === 'mux_canvas_video.webm' ||
      entry.name === 'mux_output.mp4'
    ) {
      await ffmpeg.deleteFile(entry.name);
    }
  }

  // Write the canvas-captured video to the virtual filesystem.
  const videoExt = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const videoVfsName = `mux_canvas_video.${videoExt}`;
  onStatus('Writing canvas video to FFmpeg...');
  await safeWriteFile(ffmpeg, videoVfsName, new Uint8Array(await videoBlob.arrayBuffer()), 'mux write canvas video');

  // Write each clip's source file for audio extraction.
  const audioVfsNames: string[] = [];
  for (const [i, clip] of clips.entries()) {
    const ext = getSafeExtension(clip.file.name, clip.kind === 'video' ? 'mp4' : 'mp3');
    const name = `mux_audio_${i}.${ext}`;
    await safeWriteFile(ffmpeg, name, await fetchFile(clip.file), `mux write audio ${i}`);
    audioVfsNames.push(name);
    const prepProgress = 0.87 + ((i + 1) / clips.length) * 0.04;
    emitProgress(onProgress, 'Audio mux preparation', prepProgress, false);
  }

  // Build a filter_complex that trims, fades, and concatenates all audio tracks.
  // Input 0 is the canvas video; inputs 1..N are the clip files for audio.
  const filterParts: string[] = [];
  const streamLabels: string[] = [];

  for (const [i, clip] of clips.entries()) {
    const inputIdx = i + 1; // 0 = canvas video
    const trimStart = clip.trimStart;
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const duration = getClipDuration(clip);
    const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);

    let af = `[${inputIdx}:a]atrim=start=${trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) af += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0) af += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    const label = `[amux${i}]`;
    af += label;
    filterParts.push(af);
    streamLabels.push(label);
  }

  filterParts.push(
    `${streamLabels.join('')}concat=n=${streamLabels.length}:v=0:a=1[aout]`,
  );

  const filterComplex = filterParts.join(';');

  // Build the ffmpeg argument list.
  const inputArgs: string[] = ['-i', videoVfsName];
  for (const name of audioVfsNames) {
    inputArgs.push('-i', name);
  }

  onStatus('Muxing audio with canvas video...');
  const totalDuration = clips.reduce((sum, clip) => sum + getClipDuration(clip), 0);
  await safeExec(ffmpeg, [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',         // preserve the canvas-captured video as-is
    '-c:a', 'aac',
    '-b:a', '192k',         // ExportSettings has no audioBitrate field; 192 kbps matches the existing FFmpeg path
    '-movflags', '+faststart',
    'mux_output.mp4',
  ], {
    stage: 'Muxing audio with canvas video',
    totalDuration,
    rangeStart: 0.91,
    rangeEnd: 0.995,
    onProgress,
  }, 'Canvas video + audio mux exec');

  const output = await safeReadFile(ffmpeg, 'mux_output.mp4', 'mux final read');
  const plain = new Uint8Array(output).buffer as ArrayBuffer;

  // Clean up.
  try { await ffmpeg.deleteFile(videoVfsName); } catch { /* ignore */ }
  for (const name of audioVfsNames) {
    try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
  }
  try { await ffmpeg.deleteFile('mux_output.mp4'); } catch { /* ignore */ }

  onStatus('Audio mux complete.');
  emitProgress(onProgress, 'Audio mux complete', 1, false);
  return new Blob([plain], { type: 'video/mp4' });
}

// ---------------------------------------------------------------------------
// Memory management and cleanup
// ---------------------------------------------------------------------------

/**
 * Aggressively clean up the FFmpeg virtual filesystem.
 * Lists all files in the VFS and deletes them.
 * Called after successful render to reclaim memory.
 */
export async function aggressiveCleanupFFmpegVFS(onStatus?: StatusCallback): Promise<void> {
  if (!ffmpegInstance) return;

  try {
    if (onStatus) onStatus('Cleaning up FFmpeg temporary files...');
    const files = await ffmpegInstance.listDir('/');
    for (const entry of files) {
      if (!entry.isDir) {
        try {
          await ffmpegInstance.deleteFile(entry.name);
        } catch {
          /* ignore individual file deletion errors */
        }
      }
    }
    if (onStatus) onStatus('FFmpeg temporary files cleaned up.');
  } catch (err) {
    // Log but don't throw — cleanup failures shouldn't crash the app
    console.warn('Error during aggressive FFmpeg cleanup:', err);
  }
}

/**
 * Reset the FFmpeg instance entirely, terminating the current instance
 * and forcing a fresh initialization on the next render.
 * This is a nuclear option for freeing all FFmpeg-related memory.
 * Useful when the instance encounters errors or memory pressure is too high.
 */
export async function resetFFmpegInstance(): Promise<void> {
  // Bump the generation counter so any in-flight load won't overwrite the
  // cleared state once it eventually settles.
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
    terminateFfmpegInstance(ffmpegInstance, 'resetting loaded instance');
    ffmpegInstance = null;
  }

  if (ffmpegLoadingInstance) {
    terminateFfmpegInstance(ffmpegLoadingInstance, 'resetting in-flight load');
    ffmpegLoadingInstance = null;
  }

  // Reset all loading state so the next ensureFfmpeg() starts fresh.
  ffmpegLoadingPromise = null;
  ffmpegLoadFailed = false;

  // Reset font state for the next instance
  fontLoaded = false;
}
