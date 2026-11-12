import type { FfmpegCoreURLs } from './coreSources';

/** Minimal FFmpeg surface used by clip_stacker render orchestration. */
export interface IFfmpegRuntime {
  exec(args: string[]): Promise<number>;
  /**
   * Bytes may be transferred to the FFmpeg worker rather than copied, which
   * detaches `data.buffer`: pass a copy of bytes you keep using afterwards.
   */
  writeFile(name: string, data: Uint8Array | string): Promise<boolean>;
  readFile(name: string): Promise<Uint8Array | string>;
  deleteFile(name: string): Promise<boolean>;
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>;
  terminate(): void;
}

/** A runtime the manager can point at a resolved core (worker or in-realm). */
export interface LoadableFfmpegRuntime extends IFfmpegRuntime {
  load(urls: FfmpegCoreURLs): Promise<void>;
}
