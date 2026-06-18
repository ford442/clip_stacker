/**
 * Dedicated Web Worker host for FFmpeg WASM. All heavy exec / VFS work runs
 * off the main thread; the UI thread only downloads core assets and forwards RPC.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import type {
  WorkerLogMessage,
  WorkerOutboundMessage,
  WorkerRpcRequest,
  WorkerRpcResponse,
} from './ffmpegWorkerProtocol';

let ffmpeg: FFmpeg | null = null;

function respond(id: number, response: Omit<WorkerRpcResponse, 'id'>): void {
  const message: WorkerOutboundMessage = { id, ...response };
  self.postMessage(message);
}

function postLog(message: string): void {
  const payload: WorkerLogMessage = { type: 'log', message };
  self.postMessage(payload);
}

function terminateInstance(): void {
  if (!ffmpeg) return;
  try {
    ffmpeg.terminate();
  } catch {
    /* ignore */
  }
  ffmpeg = null;
}

self.onmessage = async (event: MessageEvent<WorkerRpcRequest>) => {
  const request = event.data;
  const { id, type } = request;

  try {
    switch (type) {
      case 'load': {
        terminateInstance();
        const instance = new FFmpeg();
        instance.on('log', ({ message }) => postLog(message));
        await instance.load({
          coreURL: request.coreURL,
          wasmURL: request.wasmURL,
        });
        ffmpeg = instance;
        respond(id, { ok: true });
        break;
      }
      case 'exec': {
        if (!ffmpeg) throw new Error('FFmpeg is not loaded in worker');
        const code = await ffmpeg.exec(request.args);
        respond(id, { ok: true, result: code });
        break;
      }
      case 'writeFile': {
        if (!ffmpeg) throw new Error('FFmpeg is not loaded in worker');
        await ffmpeg.writeFile(request.name, request.data as Uint8Array);
        respond(id, { ok: true });
        break;
      }
      case 'readFile': {
        if (!ffmpeg) throw new Error('FFmpeg is not loaded in worker');
        const data = (await ffmpeg.readFile(request.name)) as Uint8Array;
        const copy = data.slice();
        self.postMessage({ id, ok: true, result: copy } satisfies WorkerRpcResponse, [
          copy.buffer,
        ]);
        break;
      }
      case 'deleteFile': {
        if (!ffmpeg) throw new Error('FFmpeg is not loaded in worker');
        const deleted = await ffmpeg.deleteFile(request.name);
        respond(id, { ok: true, result: deleted });
        break;
      }
      case 'listDir': {
        if (!ffmpeg) throw new Error('FFmpeg is not loaded in worker');
        const entries = await ffmpeg.listDir(request.path);
        respond(id, { ok: true, result: entries });
        break;
      }
      case 'terminate': {
        terminateInstance();
        respond(id, { ok: true });
        break;
      }
      default: {
        const exhaustive: never = type;
        throw new Error(`Unknown worker request type: ${exhaustive}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respond(id, { ok: false, error: message });
  }
};
