import type { FfmpegCoreURLs } from './coreSources';
import type { LoadableFfmpegRuntime } from './ffmpegRuntime';
import { transferableBytes, type FfmpegWorkerProtocol } from './ffmpegWorkerProtocol';
import { createFfmpegWorker } from '../workers/workerFactories';
import { createWorkerClient, type WorkerClient, type WorkerLike } from '../workers/workerRpc';

export interface WorkerFfmpegRuntimeOptions {
  /** Every FFmpeg log line the worker posts. */
  onLog?: (message: string) => void;
  /**
   * The worker died (an uncaught error reached `onerror`). Pending calls have
   * been rejected and this runtime refuses new ones: load a new runtime.
   */
  onWorkerLost?: (error: Error) => void;
  /** Worker factory; tests pass a fake. */
  createWorker?: () => WorkerLike;
}

/**
 * Main-thread proxy for one dedicated FFmpeg worker, through the worker RPC.
 * Implements the same runtime surface used by merge / extract / mux helpers.
 *
 * Each runtime owns its worker. `terminate()` or a crash ends it for good, so
 * a worker that died (or never loaded the core) is never reused: the manager
 * loads a fresh runtime, and with it a fresh worker, on the next call.
 */
export class WorkerFfmpegRuntime implements LoadableFfmpegRuntime {
  private readonly client: WorkerClient<FfmpegWorkerProtocol>;

  constructor(options: WorkerFfmpegRuntimeOptions = {}) {
    this.client = createWorkerClient<FfmpegWorkerProtocol>(options.createWorker ?? createFfmpegWorker, {
      name: 'FFmpeg',
      onCrash: (error) => options.onWorkerLost?.(error),
    });
    const { onLog } = options;
    if (onLog) this.client.on('log', ({ message }) => onLog(message));
  }

  async load(urls: FfmpegCoreURLs): Promise<void> {
    await this.client.call('load', { urls });
  }

  async exec(args: string[]): Promise<number> {
    return this.client.call('exec', { args });
  }

  /** Bytes are transferred, not copied: the caller's buffer is detached. */
  async writeFile(name: string, data: Uint8Array | string): Promise<boolean> {
    if (typeof data === 'string') {
      await this.client.call('writeFile', { name, data });
      return true;
    }
    const { bytes, transfer } = transferableBytes(data);
    await this.client.call('writeFile', { name, data: bytes }, { transfer });
    return true;
  }

  async readFile(name: string): Promise<Uint8Array | string> {
    const result: unknown = await this.client.call('readFile', { name });
    if (typeof result === 'string') return result;
    if (result instanceof Uint8Array) return result;
    if (result instanceof ArrayBuffer) return new Uint8Array(result);
    throw new Error(`Unexpected readFile result for ${name}`);
  }

  async deleteFile(name: string): Promise<boolean> {
    return this.client.call('deleteFile', { name });
  }

  async listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
    return this.client.call('listDir', { path });
  }

  /** Kill the worker (and the mt core's pthread workers with it). */
  terminate(): void {
    this.client.terminate();
  }
}
