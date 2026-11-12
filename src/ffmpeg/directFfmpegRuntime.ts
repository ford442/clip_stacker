import type { FfmpegCoreURLs } from './coreSources';
import type { FfmpegCoreHost } from './ffmpegCoreHost';
import type { LoadableFfmpegRuntime } from './ffmpegRuntime';

/**
 * Runs the core in this realm through an `FfmpegCoreHost` — the same code the
 * worker runs, without the worker. Used by tests and where no Worker exists;
 * exec blocks the calling thread, so the browser always uses the worker.
 */
export class DirectFfmpegRuntime implements LoadableFfmpegRuntime {
  constructor(private readonly host: FfmpegCoreHost) {}

  get underlying(): FfmpegCoreHost {
    return this.host;
  }

  async load(urls: FfmpegCoreURLs): Promise<void> {
    await this.host.load(urls);
  }

  async exec(args: string[]): Promise<number> {
    return this.host.exec(args);
  }

  async writeFile(name: string, data: Uint8Array | string): Promise<boolean> {
    await this.host.writeFile(name, data);
    return true;
  }

  async readFile(name: string): Promise<Uint8Array | string> {
    return this.host.readFile(name);
  }

  async deleteFile(name: string): Promise<boolean> {
    await this.host.deleteFile(name);
    return true;
  }

  async listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
    return this.host.listDir(path);
  }

  terminate(): void {
    try {
      this.host.terminate();
    } catch {
      /* ignore */
    }
  }
}
