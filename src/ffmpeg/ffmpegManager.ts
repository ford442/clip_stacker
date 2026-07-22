import { FFmpeg } from '@ffmpeg/ffmpeg';
import { DirectFfmpegRuntime } from './directFfmpegRuntime';
import type { IFfmpegRuntime } from './ffmpegRuntime';
import {
  buildFfmpegLoadErrorMessage,
  clampProgress,
  emitLoadStatus,
  emitProgress,
  extractErrorMessage,
  FFMPEG_CORE_CDNS,
  FFMPEG_LOAD_TIMEOUT_MS,
  getFfmpegEnvironmentDiagnostics,
  loadMtCoreSources,
  type FfmpegLogProgressContext,
  type ProgressCallback,
  type StatusCallback,
  toBlobURLWithFallback,
  withTimeout,
} from './ffmpegCommon';
import { resolveFfmpegCoreVariant } from '../utils/feature-detector';
import { WorkerFfmpegRuntime } from './workerFfmpegRuntime';

export const MAX_LOG_BUFFER = 300;

export interface FfmpegManagerOptions {
  /** When true (default in browser), FFmpeg runs inside a dedicated Web Worker. */
  useWorker?: boolean;
  /** Factory for direct in-thread FFmpeg (tests and fallback). */
  createDirectRuntime?: (onLog: (message: string) => void) => IFfmpegRuntime;
}

function defaultCreateDirectRuntime(
  onLog: (message: string) => void,
): IFfmpegRuntime {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog(message));
  return new DirectFfmpegRuntime(ffmpeg);
}

/**
 * Encapsulates FFmpeg load state, diagnostics, and runtime lifecycle.
 * Replaces the previous module-level mutable globals in core.ts.
 */
export class FfmpegManager {
  private instance: IFfmpegRuntime | null = null;
  private loadingPromise: Promise<IFfmpegRuntime> | null = null;
  private loadingRuntime: IFfmpegRuntime | null = null;
  private loadFailed = false;
  private loadGeneration = 0;
  private fontLoaded = false;
  /** Virtual font filenames that have been written to the current VFS. */
  private readonly loadedFonts = new Set<string>();
  private readonly logBuffer: string[] = [];
  private lastErrorLog: string | null = null;
  private lastCommand: string[] | null = null;
  private lastFilterComplex: string | null = null;
  activeLogProgress: FfmpegLogProgressContext | null = null;

  private readonly useWorker: boolean;
  private readonly createDirectRuntime: (
    onLog: (message: string) => void,
  ) => IFfmpegRuntime;
  private workerRuntime: WorkerFfmpegRuntime | null = null;
  private removeWorkerLogListener: (() => void) | null = null;

  constructor(options: FfmpegManagerOptions = {}) {
    this.useWorker =
      options.useWorker ??
      (typeof Worker !== 'undefined' && typeof window !== 'undefined');
    this.createDirectRuntime =
      options.createDirectRuntime ?? defaultCreateDirectRuntime;
  }

  isLoadFailed(): boolean {
    return this.loadFailed;
  }

  isLoading(): boolean {
    return this.loadingPromise !== null;
  }

  getInstance(): IFfmpegRuntime | null {
    return this.instance;
  }

  isFontLoaded(name?: string): boolean {
    if (name) return this.loadedFonts.has(name);
    return this.fontLoaded;
  }

  /** Mark a specific virtual font filename as loaded in the current VFS. */
  markFontLoaded(name: string): void {
    this.loadedFonts.add(name);
    // Maintain legacy flag for the historical default roboto.
    if (name === 'roboto.ttf') {
      this.fontLoaded = true;
    }
  }

  /** Clear all per-instance font tracking (called on reset/new instance). */
  resetFonts(): void {
    this.fontLoaded = false;
    this.loadedFonts.clear();
  }

  recordLog(message: string): void {
    this.logBuffer.push(message);
    if (this.logBuffer.length > MAX_LOG_BUFFER) {
      this.logBuffer.shift();
    }
    if (
      /error|failed|invalid|no such|cannot|unable|does not contain|matches no streams|Output file does not/i.test(
        message,
      )
    ) {
      this.lastErrorLog = message;
    }

    console.log('[FFmpeg]', message);

    if (!message.includes('time=')) return;

    const context = this.activeLogProgress;
    if (!context) return;

    const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (!match || context.totalDuration <= 0) {
      emitProgress(context.onProgress, context.stage, undefined, true);
      return;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds)
    ) {
      emitProgress(context.onProgress, context.stage, undefined, true);
      return;
    }

    const elapsed = hours * 3600 + minutes * 60 + seconds;
    const local = clampProgress(elapsed / context.totalDuration);
    const progress =
      context.rangeStart + (context.rangeEnd - context.rangeStart) * local;
    emitProgress(context.onProgress, context.stage, progress, false);
  }

  getLastLogs(count = 50): string[] {
    return this.logBuffer.slice(-Math.max(1, count));
  }

  getLastError(): string | null {
    return this.lastErrorLog;
  }

  setLastCommand(args: string[]): void {
    this.lastCommand = [...args];
    const filterIdx = args.indexOf('-filter_complex');
    if (filterIdx >= 0 && filterIdx + 1 < args.length) {
      this.lastFilterComplex = args[filterIdx + 1];
    } else {
      this.lastFilterComplex = null;
    }
  }

  getLastCommand(): string[] | null {
    return this.lastCommand ? [...this.lastCommand] : null;
  }

  getLastFilterComplex(): string | null {
    return this.lastFilterComplex;
  }

  clearLogs(): void {
    this.logBuffer.length = 0;
    this.lastErrorLog = null;
  }

  private clearTrackedLoadingRuntime(
    runtime: IFfmpegRuntime,
    terminate = false,
  ): void {
    if (this.loadingRuntime !== runtime) return;
    this.loadingRuntime = null;
    if (terminate) {
      runtime.terminate();
    }
  }

  private attachWorkerLogListener(): void {
    if (!this.useWorker || this.removeWorkerLogListener) return;
    this.removeWorkerLogListener = WorkerFfmpegRuntime.addLogListener((message) =>
      this.recordLog(message),
    );
  }

  private detachWorkerLogListener(): void {
    this.removeWorkerLogListener?.();
    this.removeWorkerLogListener = null;
  }

  private async loadRuntime(
    variant: 'mt' | 'st',
    onStatus: StatusCallback,
    onProgress?: ProgressCallback,
  ): Promise<IFfmpegRuntime> {
    this.resetFonts();
    this.attachWorkerLogListener();

    emitLoadStatus(
      onStatus,
      onProgress,
      'Loading FFmpeg core (this may take a moment)...',
    );
    this.recordLog(
      `[FFmpeg load] Environment: ${getFfmpegEnvironmentDiagnostics().join('; ')}`,
    );
    this.recordLog(`[FFmpeg load] Attempting ${variant} core variant`);

    let coreURL: string;
    let wasmURL: string;
    let workerURL: string | undefined;

    if (variant === 'mt') {
      ({ coreURL, wasmURL, workerURL } = await loadMtCoreSources(
        onStatus,
        onProgress,
        (message) => this.recordLog(message),
      ));
    } else {
      coreURL = await toBlobURLWithFallback(
        'ffmpeg-core.js',
        'text/javascript',
        onStatus,
        onProgress,
        'FFmpeg core.js',
        (message) => this.recordLog(message),
      );
      wasmURL = await toBlobURLWithFallback(
        'ffmpeg-core.wasm',
        'application/wasm',
        onStatus,
        onProgress,
        'FFmpeg core.wasm',
        (message) => this.recordLog(message),
      );
    }

    let runtime: IFfmpegRuntime;
    if (this.useWorker) {
      this.workerRuntime = new WorkerFfmpegRuntime();
      runtime = this.workerRuntime;
      this.loadingRuntime = runtime;
      emitLoadStatus(onStatus, onProgress, 'Initializing FFmpeg WASM engine...');
      this.recordLog(
        '[FFmpeg load] Starting dedicated FFmpeg worker load',
      );
      await withTimeout(
        this.workerRuntime.load(coreURL, wasmURL, workerURL),
        FFMPEG_LOAD_TIMEOUT_MS,
        'ffmpeg.load()',
      );
    } else {
      runtime = this.createDirectRuntime((message) => this.recordLog(message));
      this.loadingRuntime = runtime;
      emitLoadStatus(onStatus, onProgress, 'Initializing FFmpeg WASM engine...');
      this.recordLog(
        '[FFmpeg load] Starting direct FFmpeg load (test/fallback path)',
      );
      const abortController =
        typeof AbortController !== 'undefined' ? new AbortController() : null;
      const loadStartedAt = Date.now();
      const checkpointTimers = [5_000, 15_000, 30_000, 60_000, 90_000].map(
        (delayMs) =>
          setTimeout(() => {
            const seconds = Math.round((Date.now() - loadStartedAt) / 1000);
            const message =
              `Still initializing FFmpeg WASM engine (${seconds}s elapsed). ` +
              getFfmpegEnvironmentDiagnostics().join('; ');
            this.recordLog(`[FFmpeg load] ${message}`);
            emitLoadStatus(onStatus, onProgress, message);
          }, delayMs),
      );
      try {
        const direct = runtime as DirectFfmpegRuntime;
        await withTimeout(
          direct.load(coreURL, wasmURL, { signal: abortController?.signal, workerURL }),
          FFMPEG_LOAD_TIMEOUT_MS,
          'ffmpeg.load()',
          () => abortController?.abort(),
        );
      } finally {
        checkpointTimers.forEach(clearTimeout);
      }
    }

    this.recordLog(`[FFmpeg load] ffmpeg.load() completed successfully (${variant}).`);
    this.clearTrackedLoadingRuntime(runtime, false);
    return runtime;
  }

  async ensureFfmpeg(
    onStatus: StatusCallback,
    onProgress?: ProgressCallback,
  ): Promise<IFfmpegRuntime> {
    if (this.instance) return this.instance;

    if (this.loadingPromise) {
      emitLoadStatus(
        onStatus,
        onProgress,
        'Waiting for FFmpeg to finish loading...',
      );
      return this.loadingPromise;
    }

    this.loadFailed = false;
    const gen = this.loadGeneration;
    const maxRetries = 3;
    const preferredVariant = resolveFfmpegCoreVariant();

    const attemptWithRetry = async (): Promise<IFfmpegRuntime> => {
      // Try multi-threaded first (single attempt — mt failure is usually
      // structural, not transient; fall through immediately to st on failure).
      if (preferredVariant === 'mt') {
        if (gen !== this.loadGeneration) {
          throw new Error('FFmpeg load cancelled by reset');
        }
        try {
          const runtime = await this.loadRuntime('mt', onStatus, onProgress);
          return runtime;
        } catch (err) {
          const message = extractErrorMessage(err);
          this.recordLog(
            `[FFmpeg load] Multi-threaded load failed, falling back to single-threaded: ${message}`,
          );
          emitLoadStatus(
            onStatus,
            onProgress,
            'Multi-threaded FFmpeg unavailable — loading single-threaded fallback...',
          );
          if (this.loadingRuntime) {
            this.clearTrackedLoadingRuntime(this.loadingRuntime, true);
          }
        }
      }

      // Single-threaded with up to maxRetries attempts.
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (gen !== this.loadGeneration) {
          throw new Error('FFmpeg load cancelled by reset');
        }
        try {
          const runtime = await this.loadRuntime('st', onStatus, onProgress);
          if (attempt > 1) {
            this.recordLog(
              `[FFmpeg load] Succeeded on attempt ${attempt}/${maxRetries}`,
            );
          }
          return runtime;
        } catch (err) {
          const message = extractErrorMessage(err);
          lastError = new Error(message);
          this.recordLog(
            `[FFmpeg load] Attempt ${attempt}/${maxRetries} failed: ${message}`,
          );
          if (gen !== this.loadGeneration) {
            throw new Error('FFmpeg load cancelled by reset');
          }
          if (this.loadingRuntime) {
            this.clearTrackedLoadingRuntime(this.loadingRuntime, true);
          }
          onStatus(`FFmpeg load attempt failed: ${message}`);
          emitProgress(onProgress, 'FFmpeg load failed', undefined, true);
          if (attempt < maxRetries) {
            const delayMs = Math.pow(2, attempt) * 1000;
            emitLoadStatus(
              onStatus,
              onProgress,
              `FFmpeg load failed — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
      const finalMessage = buildFfmpegLoadErrorMessage(
        lastError?.message ?? 'unknown error',
        maxRetries,
      );
      onStatus(finalMessage);
      emitProgress(onProgress, 'FFmpeg load failed', undefined, true);
      throw new Error(finalMessage);
    };

    this.loadingPromise = attemptWithRetry()
      .then((runtime) => {
        if (gen === this.loadGeneration) {
          this.instance = runtime;
          this.loadingPromise = null;
          this.loadFailed = false;
        } else {
          runtime.terminate();
        }
        return runtime;
      })
      .catch((err) => {
        if (gen === this.loadGeneration) {
          this.loadingPromise = null;
          this.loadFailed = true;
          this.instance = null;
          this.resetFonts();
        }
        throw err;
      });

    return this.loadingPromise;
  }

  async aggressiveCleanupVFS(onStatus?: StatusCallback): Promise<void> {
    if (!this.instance) return;
    try {
      onStatus?.('Cleaning up FFmpeg temporary files...');
      const files = await this.instance.listDir('/');
      for (const entry of files) {
        if (!entry.isDir) {
          try {
            await this.instance.deleteFile(entry.name);
          } catch {
            /* ignore */
          }
        }
      }
      onStatus?.('FFmpeg temporary files cleaned up.');
    } catch (err) {
      console.warn('Error during aggressive FFmpeg cleanup:', err);
    }
  }

  async reset(): Promise<void> {
    this.loadGeneration++;
    if (this.instance) {
      try {
        await this.aggressiveCleanupVFS();
      } catch {
        /* ignore */
      }
      this.instance.terminate();
      this.instance = null;
    }
    if (this.loadingRuntime) {
      this.loadingRuntime.terminate();
      this.loadingRuntime = null;
    }
    this.loadingPromise = null;
    this.loadFailed = false;
    this.resetFonts();
    this.workerRuntime = null;
    this.detachWorkerLogListener();
    if (this.useWorker) {
      WorkerFfmpegRuntime.disposeSharedWorker();
    }
  }
}

let defaultManager: FfmpegManager | null = null;

export function getFfmpegManager(): FfmpegManager {
  if (!defaultManager) {
    defaultManager = new FfmpegManager();
  }
  return defaultManager;
}

export function setFfmpegManagerForTesting(manager: FfmpegManager): void {
  defaultManager = manager;
}

export function resetFfmpegManagerForTesting(): void {
  defaultManager = null;
}

export { FFMPEG_CORE_CDNS };
