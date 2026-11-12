import type { FfmpegCoreHost } from './ffmpegCoreHost';
import {
  transferableBytes,
  type WorkerRpcRequest,
  type WorkerRpcResponse,
} from './ffmpegWorkerProtocol';

export interface WorkerReply {
  response: WorkerRpcResponse;
  transfer: Transferable[];
}

/**
 * Error text for the main thread. Emscripten's `FS.ErrnoError` says only
 * "FS error", so its name and errno are kept (as `@ffmpeg/ffmpeg`'s
 * `toString()` kept the name); our own errors pass their message through.
 */
export function describeWorkerError(error: unknown): string {
  if (error instanceof Error) {
    const errno = (error as { errno?: unknown }).errno;
    const named =
      error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
    return typeof errno === 'number' ? `${named} (errno ${errno})` : named;
  }
  return String(error);
}

/** Run one RPC against the core host and build the reply to post back. */
export async function handleFfmpegWorkerRequest(
  host: FfmpegCoreHost,
  request: WorkerRpcRequest,
): Promise<WorkerReply> {
  const { id } = request;
  const ok = (result?: unknown): WorkerReply => ({
    response: { id, ok: true, result },
    transfer: [],
  });
  try {
    switch (request.type) {
      case 'load':
        await host.load(request.urls);
        return ok();
      case 'exec': {
        const code = host.exec(request.args);
        if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
        return ok(code);
      }
      case 'writeFile':
        host.writeFile(request.name, request.data);
        return ok();
      case 'readFile': {
        // FS.readFile returns a fresh array: transfer it without a copy.
        const { bytes, transfer } = transferableBytes(host.readFile(request.name));
        return { response: { id, ok: true, result: bytes }, transfer };
      }
      case 'deleteFile':
        host.deleteFile(request.name);
        return ok(true);
      case 'listDir':
        return ok(host.listDir(request.path));
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown worker request type: ${String((exhaustive as { type?: unknown }).type)}`);
      }
    }
  } catch (error) {
    return { response: { id, ok: false, error: describeWorkerError(error) }, transfer: [] };
  }
}
