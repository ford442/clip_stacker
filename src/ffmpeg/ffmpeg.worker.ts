/**
 * Dedicated Web Worker host for FFmpeg WASM. It drives the `@ffmpeg/core`
 * Emscripten module itself (`FfmpegCoreHost`), so there is no second
 * `@ffmpeg/ffmpeg` worker in between: main → this worker (→ the mt core's
 * pthread workers). All exec / VFS work runs here; main resolves the core
 * URLs and calls through the worker RPC (`workerFfmpegRuntime.ts`,
 * protocol in `ffmpegWorkerProtocol.ts`).
 */
import { FfmpegCoreHost } from './ffmpegCoreHost';
import { createFfmpegWorkerHandlers } from './ffmpegWorkerHandler';
import type { FfmpegWorkerProtocol } from './ffmpegWorkerProtocol';
import { exposeWorker } from '../workers/workerRpc';

exposeWorker<FfmpegWorkerProtocol>((port) =>
  createFfmpegWorkerHandlers(new FfmpegCoreHost((message) => port.emit('log', { message }))),
);
