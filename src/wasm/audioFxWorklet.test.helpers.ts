/**
 * Loads the shipped worklet script (`public/worklets/audio-fx-processor.js`)
 * in a stand-in AudioWorkletGlobalScope, for tests that drive the processor
 * directly against the shipped `media_engine_fx.wasm`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const WORKLET_RATE = 48000;
export const WORKLET_QUANTUM = 128;

export interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  posted: unknown[];
  postMessage(data: unknown): void;
}

export interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

export type ProcessorClass = new (options: unknown) => Processor;

/** Evaluate the worklet script; returns its processor class. */
export function loadProcessorClass(): ProcessorClass {
  const source = readFileSync(path.resolve(process.cwd(), 'public/worklets/audio-fx-processor.js'), 'utf8');
  class AudioWorkletProcessor {
    port: FakePort = {
      onmessage: null,
      posted: [],
      postMessage(data: unknown) {
        this.posted.push(data);
      },
    };
  }
  let registered: ProcessorClass | null = null;
  const registerProcessor = (_name: string, cls: ProcessorClass) => {
    registered = cls;
  };
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    AudioWorkletProcessor,
    registerProcessor,
    WORKLET_RATE,
  );
  if (!registered) throw new Error('processor not registered');
  return registered;
}

export function loadFxModule(): Promise<WebAssembly.Module> {
  return WebAssembly.compile(readFileSync(path.resolve(process.cwd(), 'public/wasm/media_engine_fx.wasm')));
}

/** Wait until the processor posts `ready` (resolves its latency) or `error` (rejects). */
export async function waitForReady(proc: Processor): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const ready = proc.port.posted.find((m) => (m as { type?: string }).type === 'ready') as
      | { latency: number }
      | undefined;
    if (ready) return ready.latency;
    const error = proc.port.posted.find((m) => (m as { type?: string }).type === 'error');
    if (error) throw new Error(JSON.stringify(error));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('worklet never became ready');
}
