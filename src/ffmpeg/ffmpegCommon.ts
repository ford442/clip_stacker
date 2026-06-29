import { toBlobURL } from '@ffmpeg/util';

export type StatusCallback = (message: string) => void;

export interface RenderProgressUpdate {
  stage: string;
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

export function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.toString();
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage) return maybeMessage;
  }
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

/** Normalize worker/string/Error throws into a display-safe message. */
export function normalizeError(error: unknown): string {
  return extractErrorMessage(error);
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
      typeof progress === 'number' ? clampProgress(progress) : undefined,
    indeterminate: indeterminate || typeof progress !== 'number',
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
  if (baseURL.includes('/ffmpeg-core')) return 'local hosted FFmpeg core';
  if (baseURL.includes('cdn.jsdelivr.net')) return 'jsDelivr CDN';
  if (baseURL.includes('unpkg.com')) return 'unpkg CDN';
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}

export function getLocalFfmpegCoreBaseURL(): string {
  const base =
    typeof document !== 'undefined'
      ? document.baseURI
      : typeof window !== 'undefined'
        ? window.location.href
        : 'http://localhost/';
  return new URL('ffmpeg-core', base).href.replace(/\/$/, '');
}

export const FFMPEG_CORE_CDNS = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm',
];

export function getFfmpegCoreSources(): string[] {
  return [getLocalFfmpegCoreBaseURL(), ...FFMPEG_CORE_CDNS];
}

export function buildFfmpegLoadErrorMessage(
  message: string,
  attempts = 1,
): string {
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

export const FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS = 45_000;
export const FFMPEG_LOAD_TIMEOUT_MS = 120_000;

export function getFfmpegEnvironmentDiagnostics(): string[] {
  const lines: string[] = [];
  const globalScope = globalThis as typeof globalThis & {
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: typeof SharedArrayBuffer;
  };

  lines.push(
    `location=${typeof window !== 'undefined' ? window.location.href : 'n/a'}`,
  );
  lines.push(
    `protocol=${typeof window !== 'undefined' ? window.location.protocol : 'n/a'}`,
  );
  lines.push(`crossOriginIsolated=${globalScope.crossOriginIsolated === true}`);
  lines.push(`Worker=${typeof Worker !== 'undefined'}`);
  lines.push(`WebAssembly=${typeof WebAssembly !== 'undefined'}`);
  lines.push(
    `SharedArrayBuffer=${typeof globalScope.SharedArrayBuffer !== 'undefined'}`,
  );
  lines.push(
    `hardwareConcurrency=${typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 'unknown') : 'n/a'}`,
  );
  lines.push(`ffmpegCoreSources=${getFfmpegCoreSources().join(',')}`);
  lines.push('ffmpegWorkerURL=dedicated clip_stacker ffmpeg.worker.ts');

  return lines;
}

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

export async function toBlobURLWithRetry(
  url: string,
  mimeType: string,
  onStatus: StatusCallback | undefined,
  onProgress: ProgressCallback | undefined,
  label: string | undefined,
  recordLog: (message: string) => void,
): Promise<string> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (onStatus && label) {
        const suffix = attempt > 1 ? ` (attempt ${attempt}/${maxRetries})` : '';
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
      const delayMs = Math.pow(2, attempt) * 1000;
      recordLog(
        `[FFmpeg load] Download failed for ${url} (attempt ${attempt}): ${(error as Error).message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    'toBlobURLWithRetry: Unexpected - loop should always return or throw',
  );
}

export async function toBlobURLWithFallback(
  filename: string,
  mimeType: string,
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  label: string,
  recordLog: (message: string) => void,
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
        recordLog,
      );
    } catch (err) {
      lastError = err as Error;
      recordLog(
        `[FFmpeg load] Source ${baseURL} failed for ${filename}: ${lastError.message}`,
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
    `Failed to download ${filename} from local assets and all fallback CDNs. Last error: ${lastError?.message ?? 'unknown'}`,
  );
}
