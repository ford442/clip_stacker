import type { FfmpegCoreURLs } from './coreSources';
import type { LoadableFfmpegRuntime } from './ffmpegRuntime';
import {
  transferableBytes,
  type DistributiveOmit,
  type WorkerOutboundMessage,
  type WorkerRpcRequest,
} from './ffmpegWorkerProtocol';

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export interface WorkerFfmpegRuntimeOptions {
  /** Every FFmpeg log line the worker posts. */
  onLog?: (message: string) => void;
  /**
   * The worker died (an uncaught error reached `onerror`). Pending calls have
   * been rejected and this runtime refuses new ones: load a new runtime.
   */
  onWorkerLost?: (error: Error) => void;
  /** Worker factory; tests pass a fake. */
  createWorker?: () => Worker;
}

function createFfmpegWorker(): Worker {
  return new Worker(new URL('./ffmpeg.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * Main-thread RPC proxy for one dedicated FFmpeg worker. Implements the same
 * runtime surface used by merge / extract / mux helpers.
 *
 * Each runtime owns its worker. `terminate()` or a crash ends it for good, so
 * a worker that died (or never loaded the core) is never reused: the manager
 * loads a fresh runtime, and with it a fresh worker, on the next call.
 */
export class WorkerFfmpegRuntime implements LoadableFfmpegRuntime {
  private worker: Worker | null = null;
  /** Set once the worker is gone; every later call rejects with it. */
  private failure: Error | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRpc>();

  constructor(private readonly options: WorkerFfmpegRuntimeOptions = {}) {}

  private ensureWorker(): Worker {
    if (this.failure) throw this.failure;
    if (this.worker) return this.worker;

    const worker = (this.options.createWorker ?? createFfmpegWorker)();
    worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      this.handleMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      const error = new Error(event.message || 'FFmpeg worker error');
      this.shutdown(error);
      this.options.onWorkerLost?.(error);
    };
    this.worker = worker;
    return worker;
  }

  private handleMessage(data: WorkerOutboundMessage): void {
    if ('type' in data) {
      this.options.onLog?.(data.message);
      return;
    }
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.ok) {
      pending.resolve(data.result);
    } else {
      pending.reject(new Error(data.error));
    }
  }

  /** Reject everything in flight, kill the worker and refuse later calls. */
  private shutdown(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  private rpc(
    request: DistributiveOmit<WorkerRpcRequest, 'id'>,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...request } as WorkerRpcRequest, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async load(urls: FfmpegCoreURLs): Promise<void> {
    await this.rpc({ type: 'load', urls });
  }

  async exec(args: string[]): Promise<number> {
    return (await this.rpc({ type: 'exec', args })) as number;
  }

  /** Bytes are transferred, not copied: the caller's buffer is detached. */
  async writeFile(name: string, data: Uint8Array | string): Promise<boolean> {
    if (typeof data === 'string') {
      await this.rpc({ type: 'writeFile', name, data });
      return true;
    }
    const { bytes, transfer } = transferableBytes(data);
    await this.rpc({ type: 'writeFile', name, data: bytes }, transfer);
    return true;
  }

  async readFile(name: string): Promise<Uint8Array | string> {
    const result = await this.rpc({ type: 'readFile', name });
    if (typeof result === 'string') return result;
    if (result instanceof Uint8Array) return result;
    if (result instanceof ArrayBuffer) return new Uint8Array(result);
    throw new Error(`Unexpected readFile result for ${name}`);
  }

  async deleteFile(name: string): Promise<boolean> {
    return (await this.rpc({ type: 'deleteFile', name })) as boolean;
  }

  async listDir(path: string): Promise<{ name: string; isDir: boolean }[]> {
    return (await this.rpc({ type: 'listDir', path })) as {
      name: string;
      isDir: boolean;
    }[];
  }

  /** Kill the worker (and the mt core's pthread workers with it). */
  terminate(): void {
    if (this.failure && !this.worker) return;
    this.shutdown(new Error('FFmpeg worker terminated'));
  }
}
