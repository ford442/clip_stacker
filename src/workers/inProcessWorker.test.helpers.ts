/**
 * A Worker and its global scope joined in-process, for tests: every message
 * goes through `structuredClone` with its transfer list (as `postMessage`
 * does, so transferred buffers detach), main → worker on a microtask and
 * worker → main on the next macrotask. `crash()` fires the worker's `error`.
 */

import type { WorkerLike, WorkerScopeLike } from './workerRpc';

export class InProcessWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  terminated = false;
  /** Every envelope main posted (after cloning) and the transfer list it came with. */
  readonly posted: Array<{ message: unknown; transfer: Transferable[] }> = [];
  /** Every envelope the worker posted (after cloning). */
  readonly emitted: unknown[] = [];
  /** Drop main → worker messages (to leave calls pending). */
  hold = false;

  readonly scope: WorkerScopeLike;

  constructor() {
    const scope: WorkerScopeLike = {
      onmessage: null,
      postMessage: (message, transfer) => {
        if (this.terminated) return;
        const copy: unknown = structuredClone(message, { transfer });
        this.emitted.push(copy);
        setTimeout(() => {
          if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: copy }));
        }, 0);
      },
    };
    this.scope = scope;
  }

  postMessage(message: unknown, transfer: Transferable[]): void {
    if (this.terminated) throw new Error('worker terminated');
    const copy: unknown = structuredClone(message, { transfer });
    this.posted.push({ message: copy, transfer });
    if (this.hold) return;
    queueMicrotask(() => {
      if (!this.terminated) this.scope.onmessage?.(new MessageEvent('message', { data: copy }));
    });
  }

  crash(message: string): void {
    this.onerror?.(new ErrorEvent('error', { message }));
  }

  messageError(): void {
    this.onmessageerror?.(new MessageEvent('messageerror'));
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The payloads main sent as `kind` ('call' / 'notify') named `name`. */
  sentPayloads<T = unknown>(kind: 'call' | 'notify', name: string): T[] {
    return this.posted
      .map((p) => p.message)
      .filter((m): m is { rpc: string; method?: string; name?: string; payload: unknown } => isEnvelope(m) && m.rpc === kind)
      .filter((m) => (kind === 'call' ? m.method : m.name) === name)
      .map((m) => m.payload as T);
  }

  /** The payloads the worker emitted as event `name`. */
  eventPayloads<T = unknown>(name: string): T[] {
    return this.emitted
      .filter((m): m is { rpc: string; name: string; payload: unknown } => isEnvelope(m) && m.rpc === 'event')
      .filter((m) => m.name === name)
      .map((m) => m.payload as T);
  }
}

function isEnvelope(m: unknown): m is { rpc: string } {
  return typeof m === 'object' && m !== null && 'rpc' in m;
}

/** Let queued deliveries (microtasks and the 0 ms timers) run. */
export function flushWorkerMessages(rounds = 3): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  return p;
}
