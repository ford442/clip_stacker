import type { FfmpegCoreURLs } from './coreSources';

/** Omit that distributes over each member of a union, preserving discriminants. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type WorkerRpcRequest =
  | {
      id: number;
      type: 'load';
      /** Same-origin `/ffmpeg-core*` URLs, or blob: URLs of a CDN copy. */
      urls: FfmpegCoreURLs;
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
    };

export type WorkerRpcResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

export type WorkerLogMessage = { type: 'log'; message: string };

export type WorkerOutboundMessage = WorkerRpcResponse | WorkerLogMessage;

/**
 * The bytes to post and the transfer list for them. A view over a whole,
 * non-shared ArrayBuffer is transferred as-is (no copy; the sender's buffer is
 * detached). A view over part of a buffer is copied first, so the transfer
 * neither ships nor detaches bytes the view does not own. A SharedArrayBuffer
 * cannot be transferred and is not copied: the receiver reads shared memory.
 */
export function transferableBytes(data: Uint8Array): {
  bytes: Uint8Array;
  transfer: Transferable[];
} {
  const buffer = data.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    return { bytes: data, transfer: [] };
  }
  if (data.byteOffset === 0 && data.byteLength === buffer.byteLength) {
    return { bytes: data, transfer: [buffer] };
  }
  const copy = data.slice();
  return { bytes: copy, transfer: [copy.buffer] };
}
