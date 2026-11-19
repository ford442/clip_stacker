import type { FfmpegCoreHost } from './ffmpegCoreHost';
import { transferableBytes, type FfmpegWorkerProtocol } from './ffmpegWorkerProtocol';
import { withTransfer, type WorkerHandlers } from '../workers/workerRpc';

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

/** Run `fn`, rethrowing any failure as a plain Error carrying `describeWorkerError`'s text. */
async function described<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(describeWorkerError(error), { cause: error });
  }
}

/** The worker's handler table over one core host. */
export function createFfmpegWorkerHandlers(host: FfmpegCoreHost) {
  return {
    load: ({ urls }) => described(() => host.load(urls)),
    exec: ({ args }) =>
      described(() => {
        const code = host.exec(args);
        if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
        return code;
      }),
    writeFile: ({ name, data }) => described(() => host.writeFile(name, data)),
    readFile: ({ name }) =>
      described(() => {
        // FS.readFile returns a fresh array: transfer it without a copy.
        const { bytes, transfer } = transferableBytes(host.readFile(name));
        return withTransfer<Uint8Array | string>(bytes, transfer);
      }),
    deleteFile: ({ name }) =>
      described(() => {
        host.deleteFile(name);
        return true;
      }),
    listDir: ({ path }) => described(() => host.listDir(path)),
  } satisfies WorkerHandlers<FfmpegWorkerProtocol>;
}
