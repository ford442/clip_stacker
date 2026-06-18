/** Minimal FFmpeg surface used by clip_stacker render orchestration. */
export interface IFfmpegRuntime {
  exec(args: string[]): Promise<number>;
  writeFile(name: string, data: Uint8Array | string): Promise<void>;
  readFile(name: string): Promise<Uint8Array>;
  deleteFile(name: string): Promise<boolean>;
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>;
  terminate(): void;
}

export type FfmpegRuntimeFactory = () => IFfmpegRuntime;
