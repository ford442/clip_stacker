/**
 * Time-stretch worker: runs the chunked WASM session (`wasmRemapPlanar`) off
 * the main thread. Main transfers the planar source in and gets it back with
 * the planar output, both by transfer (no copies). Protocol below, served
 * through the worker RPC (`src/workers/workerRpc.ts`).
 */

import { wasmRemapPlanar } from '../wasm/timeStretch';
import { exposeWorker, withTransfer, type WorkerHandlers } from '../workers/workerRpc';

export interface TimeStretchRequest {
  input: Float32Array;
  inFrames: number;
  channels: number;
  offsets: Float64Array;
  outFrames: number;
  hop: number;
  /** Main's `public/wasm/` base (a worker's own location is its script URL). */
  baseUrl: string;
}

export interface TimeStretchResponse {
  /** Planar output; null = use the JS fallback (module unavailable or failed). */
  output: Float32Array | null;
  /** The request's input, handed back. */
  input: Float32Array;
  error?: string;
}

export type TimeStretchProtocol = {
  remap: { req: TimeStretchRequest; res: TimeStretchResponse };
};

async function remap(req: TimeStretchRequest): Promise<TimeStretchResponse> {
  try {
    const output = await wasmRemapPlanar(req.input, req.inFrames, req.channels, req.offsets, req.outFrames, {
      hop: req.hop,
      baseUrl: req.baseUrl,
    });
    return { output, input: req.input };
  } catch (err) {
    return { output: null, input: req.input, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The worker's whole job, exported so tests can serve it in-process. */
export const timeStretchHandlers: WorkerHandlers<TimeStretchProtocol> = {
  remap: async (req) => {
    const res = await remap(req);
    const transfer: Transferable[] = [res.input.buffer];
    if (res.output) transfer.push(res.output.buffer);
    return withTransfer(res, transfer);
  },
};

exposeWorker<TimeStretchProtocol>(timeStretchHandlers);
