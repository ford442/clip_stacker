/**
 * Dedicated Web Worker host for FFmpeg WASM. It drives the `@ffmpeg/core`
 * Emscripten module itself (`FfmpegCoreHost`), so there is no second
 * `@ffmpeg/ffmpeg` worker in between: main → this worker (→ the mt core's
 * pthread workers). All exec / VFS work runs here; main resolves the core
 * URLs and forwards RPC (`workerFfmpegRuntime.ts`).
 */
import { FfmpegCoreHost } from './ffmpegCoreHost';
import { handleFfmpegWorkerRequest } from './ffmpegWorkerHandler';
import type { WorkerLogMessage, WorkerRpcRequest } from './ffmpegWorkerProtocol';

const scope = self as DedicatedWorkerGlobalScope;

const host = new FfmpegCoreHost((message) => {
  const payload: WorkerLogMessage = { type: 'log', message };
  scope.postMessage(payload);
});

scope.onmessage = async (event: MessageEvent<WorkerRpcRequest>) => {
  const { response, transfer } = await handleFfmpegWorkerRequest(host, event.data);
  scope.postMessage(response, transfer);
};
