import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { IFfmpegRuntime } from './ffmpegRuntime';

/** Wraps a live @ffmpeg/ffmpeg instance (used in tests and inside the worker). */
export class DirectFfmpegRuntime implements IFfmpegRuntime {
  constructor(private readonly ffmpeg: FFmpeg) {}

  get underlying(): FFmpeg {
    return this.ffmpeg;
  }

  async load(
    coreURL: string,
    wasmURL: string,
    options?: { signal?: AbortSignal; workerURL?: string },
  ): Promise<void> {
    await this.ffmpeg.load(
      {
        coreURL,
        wasmURL,
        ...(options?.workerURL ? { workerURL: options.workerURL } : {}),
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  exec(args: string[]): Promise<number> {
    return this.ffmpeg.exec(args);
  }

  writeFile(name: string, data: Uint8Array | string): Promise<void> {
    return this.ffmpeg.writeFile(name, data as Uint8Array);
  }

  async readFile(name: string): Promise<Uint8Array> {
    return (await this.ffmpeg.readFile(name)) as Uint8Array;
  }

  deleteFile(name: string): Promise<boolean> {
    return this.ffmpeg.deleteFile(name);
  }

  listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
    return this.ffmpeg.listDir(path);
  }

  terminate(): void {
    try {
      this.ffmpeg.terminate();
    } catch {
      /* ignore */
    }
  }
}
