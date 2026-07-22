import type { IFfmpegRuntime } from './ffmpegRuntime';
import type {
  WorkerOutboundMessage,
  WorkerRpcRequest,
} from './ffmpegWorkerProtocol';

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Main-thread RPC proxy for the dedicated FFmpeg worker. Implements the same
 * runtime surface used by merge / extract / mux helpers.
 */
export class WorkerFfmpegRuntime implements IFfmpegRuntime {
  private static sharedWorker: Worker | null = null;
  private static nextId = 0;
  private static readonly pending = new Map<number, PendingRpc>();
  private static readonly logListeners = new Set<(message: string) => void>();

  static addLogListener(listener: (message: string) => void): () => void {
    WorkerFfmpegRuntime.logListeners.add(listener);
    return () => WorkerFfmpegRuntime.logListeners.delete(listener);
  }

  private static ensureWorker(): Worker {
    if (WorkerFfmpegRuntime.sharedWorker) {
      return WorkerFfmpegRuntime.sharedWorker;
    }

    const worker = new Worker(
      new URL('./ffmpeg.worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      const data = event.data;
      if ('type' in data && data.type === 'log') {
        WorkerFfmpegRuntime.logListeners.forEach((listener) =>
          listener(data.message),
        );
        return;
      }

      const pending = WorkerFfmpegRuntime.pending.get(data.id);
      if (!pending) return;
      WorkerFfmpegRuntime.pending.delete(data.id);
      if (data.ok) {
        pending.resolve(data.result);
      } else {
        pending.reject(new Error(data.error));
      }
    };

    worker.onerror = (event) => {
      const error = new Error(event.message || 'FFmpeg worker error');
      for (const pending of WorkerFfmpegRuntime.pending.values()) {
        pending.reject(error);
      }
      WorkerFfmpegRuntime.pending.clear();
    };

    WorkerFfmpegRuntime.sharedWorker = worker;
    return worker;
  }

  private rpc(
    request: Omit<WorkerRpcRequest, 'id'>,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    const id = ++WorkerFfmpegRuntime.nextId;
    return new Promise((resolve, reject) => {
      WorkerFfmpegRuntime.pending.set(id, { resolve, reject });
      WorkerFfmpegRuntime.ensureWorker().postMessage(
        { id, ...request } as WorkerRpcRequest,
        transfer,
      );
    });
  }

  async load(coreURL: string, wasmURL: string, workerURL?: string): Promise<void> {
    await this.rpc({ type: 'load', coreURL, wasmURL, workerURL });
  }

  async exec(args: string[]): Promise<number> {
    return (await this.rpc({ type: 'exec', args })) as number;
  }

  async writeFile(name: string, data: Uint8Array | string): Promise<void> {
    if (typeof data === 'string') {
      await this.rpc({ type: 'writeFile', name, data });
      return;
    }
    const copy = data.slice();
    await this.rpc({ type: 'writeFile', name, data: copy }, [copy.buffer]);
  }

  async readFile(name: string): Promise<Uint8Array> {
    const result = await this.rpc({ type: 'readFile', name });
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

  terminate(): void {
    void this.rpc({ type: 'terminate' }).catch(() => {
      /* ignore */
    });
  }

  static disposeSharedWorker(): void {
    if (!WorkerFfmpegRuntime.sharedWorker) return;
    WorkerFfmpegRuntime.sharedWorker.terminate();
    WorkerFfmpegRuntime.sharedWorker = null;
    WorkerFfmpegRuntime.pending.clear();
    WorkerFfmpegRuntime.logListeners.clear();
  }
}
