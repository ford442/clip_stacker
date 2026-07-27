/** Omit that distributes over each member of a union, preserving discriminants. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type WorkerRpcRequest =
  | {
      id: number;
      type: 'load';
      coreURL: string;
      wasmURL: string;
      /** Present when loading the multi-threaded core variant. */
      workerURL?: string;
    }
  | {
      id: number;
      type: 'exec';
      args: string[];
    }
  | {
      id: number;
      type: 'writeFile';
      name: string;
      data: Uint8Array | string;
    }
  | {
      id: number;
      type: 'readFile';
      name: string;
    }
  | {
      id: number;
      type: 'deleteFile';
      name: string;
    }
  | {
      id: number;
      type: 'listDir';
      path: string;
    }
  | {
      id: number;
      type: 'terminate';
    };

export type WorkerRpcResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

export type WorkerLogMessage = { type: 'log'; message: string };

export type WorkerOutboundMessage = WorkerRpcResponse | WorkerLogMessage;
