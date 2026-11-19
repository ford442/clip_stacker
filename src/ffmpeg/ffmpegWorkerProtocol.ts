import type { FfmpegCoreURLs } from './coreSources';

/**
 * The FFmpeg worker's protocol (`workerFfmpegRuntime.ts` on main,
 * `ffmpeg.worker.ts`), served through the worker RPC
 * (`src/workers/workerRpc.ts`). Bytes travel by transfer (`transferableBytes`).
 */
export type FfmpegWorkerProtocol = {
  /** Same-origin `/ffmpeg-core*` URLs, or blob: URLs of a CDN copy. */
  load: { req: { urls: FfmpegCoreURLs }; res: void };
  /** Rejects on a non-zero exit code. */
  exec: { req: { args: string[] }; res: number };
  writeFile: { req: { name: string; data: Uint8Array | string }; res: void };
  readFile: { req: { name: string }; res: Uint8Array | string };
  deleteFile: { req: { name: string }; res: boolean };
  listDir: { req: { path: string }; res: { name: string; isDir: boolean }[] };
  /** Every FFmpeg log line. */
  log: { event: { message: string } };
};

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
