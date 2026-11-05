/**
 * Time-stretch worker: runs the chunked WASM session (`wasmRemapPlanar`) off
 * the main thread. Main transfers the planar source in and gets it back with
 * the planar output, both by transfer (no copies).
 */

import { wasmRemapPlanar } from '../wasm/timeStretch';

export interface TimeStretchRequest {
  id: number;
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
  id: number;
  /** Planar output; null = use the JS fallback (module unavailable or failed). */
  output: Float32Array | null;
  /** The request's input, handed back. */
  input: Float32Array;
  error?: string;
}

/** The worker's whole job, separated from `onmessage` so tests can drive it in-process. */
export async function handleTimeStretchRequest(req: TimeStretchRequest): Promise<TimeStretchResponse> {
  try {
    const output = await wasmRemapPlanar(req.input, req.inFrames, req.channels, req.offsets, req.outFrames, {
      hop: req.hop,
      baseUrl: req.baseUrl,
    });
    return { id: req.id, output, input: req.input };
  } catch (err) {
    return { id: req.id, output: null, input: req.input, error: (err as Error)?.message || String(err) };
  }
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent<TimeStretchRequest>) => void) | null;
  postMessage(message: TimeStretchResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope & { document?: unknown };
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function') {
  scope.onmessage = (ev) => {
    void handleTimeStretchRequest(ev.data).then((res) => {
      const transfer: Transferable[] = [res.input.buffer];
      if (res.output) transfer.push(res.output.buffer);
      scope.postMessage(res, transfer);
    });
  };
}
