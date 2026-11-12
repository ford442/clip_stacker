import type { FfmpegCoreURLs } from './coreSources';

/**
 * Drives one `@ffmpeg/core` Emscripten module in the current realm — what
 * `@ffmpeg/ffmpeg`'s worker.js does, minus the worker. `ffmpeg.worker.ts`
 * hosts it, so FFmpeg runs one worker below the page instead of two (plus the
 * mt core's own pthread workers). Pure: no DOM, React or store.
 */

interface FfmpegCoreFS {
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string, opts: { encoding: 'binary' }): Uint8Array;
  unlink(path: string): void;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
}

/** The part of the `@ffmpeg/core` Module this host uses (its pre-js API). */
export interface FfmpegCoreModule {
  FS: FfmpegCoreFS;
  /** Exit code of the last `exec`; `reset()` puts it back to -1. */
  ret: number;
  exec(...args: string[]): number;
  reset(): void;
  setLogger(logger: (log: { type: string; message: string }) => void): void;
  setTimeout(timeoutMs: number): void;
  /** Present on the multi-threaded core. */
  PThread?: { terminateAllThreads?: () => void };
}

/** `createFFmpegCore`, the default export of `ffmpeg-core.js`. */
export type FfmpegCoreFactory = (moduleArg: {
  mainScriptUrlOrBlob: string;
}) => Promise<FfmpegCoreModule>;

export type ImportFfmpegCore = (coreURL: string) => Promise<FfmpegCoreFactory>;

async function importFfmpegCore(coreURL: string): Promise<FfmpegCoreFactory> {
  // Same-origin URL or blob: URL — both allowed by script-src ('self' blob:).
  const mod = (await import(/* @vite-ignore */ coreURL)) as { default?: unknown };
  if (typeof mod.default !== 'function') {
    throw new Error(`failed to import ffmpeg-core.js from ${coreURL}`);
  }
  return mod.default as FfmpegCoreFactory;
}

/**
 * The core overwrites any `locateFile` passed in with its own, which reads the
 * wasm and pthread-worker URLs from a base64 JSON fragment on
 * `mainScriptUrlOrBlob`. The mt core also posts that URL to every pthread
 * worker, which `import()`s it, so it must be the core script itself.
 */
export function buildMainScriptUrl({ coreURL, wasmURL, workerURL }: FfmpegCoreURLs): string {
  const located = workerURL ? { wasmURL, workerURL } : { wasmURL };
  return `${coreURL}#${btoa(JSON.stringify(located))}`;
}

function disposeCore(core: FfmpegCoreModule): void {
  try {
    core.PThread?.terminateAllThreads?.();
  } catch {
    /* ignore */
  }
}

export class FfmpegCoreHost {
  private core: FfmpegCoreModule | null = null;
  private generation = 0;

  constructor(
    private readonly onLog: (message: string) => void,
    private readonly importCore: ImportFfmpegCore = importFfmpegCore,
  ) {}

  /** Load (or reload) the core. A `terminate()` while loading cancels it. */
  async load(urls: FfmpegCoreURLs): Promise<void> {
    this.terminate();
    const generation = this.generation;
    const factory = await this.importCore(urls.coreURL);
    const core = await factory({ mainScriptUrlOrBlob: buildMainScriptUrl(urls) });
    if (generation !== this.generation) {
      disposeCore(core);
      throw new Error('FFmpeg load cancelled');
    }
    core.setLogger(({ message }) => this.onLog(message));
    this.core = core;
  }

  /** Run one command; returns FFmpeg's exit code (0 = success). */
  exec(args: string[], timeoutMs = -1): number {
    const core = this.requireCore();
    core.setTimeout(timeoutMs);
    try {
      core.exec(...args);
      return core.ret;
    } finally {
      core.reset();
    }
  }

  writeFile(path: string, data: Uint8Array | string): void {
    this.requireCore().FS.writeFile(path, data);
  }

  /** A fresh array (Emscripten copies out of MEMFS), safe to transfer. */
  readFile(path: string): Uint8Array {
    return this.requireCore().FS.readFile(path, { encoding: 'binary' });
  }

  deleteFile(path: string): void {
    this.requireCore().FS.unlink(path);
  }

  listDir(path: string): { name: string; isDir: boolean }[] {
    const fs = this.requireCore().FS;
    return fs.readdir(path).map((name) => ({
      name,
      isDir: fs.isDir(fs.stat(`${path}/${name}`).mode),
    }));
  }

  /** Drop the module (and the mt core's pthread workers). */
  terminate(): void {
    this.generation++;
    if (this.core) disposeCore(this.core);
    this.core = null;
  }

  private requireCore(): FfmpegCoreModule {
    if (!this.core) throw new Error('FFmpeg is not loaded');
    return this.core;
  }
}
