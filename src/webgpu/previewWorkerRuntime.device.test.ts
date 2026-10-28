import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewWorkerRuntime } from './previewWorkerRuntime';
import { getGpuErrorLog, __resetGpuContextForTests } from './gpuDevice';
import type { PreviewWorkerInbound, PreviewWorkerOutbound } from './previewWorkerProtocol';

/** Just enough of a module Worker to get through the two-phase handshake. */
class FakeWorker extends EventTarget {
  static last: FakeWorker | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();

  constructor() {
    super();
    FakeWorker.last = this;
    queueMicrotask(() =>
      this.emit({
        type: 'ready',
        webgpuAvailable: true,
        webgpuProbe: { ok: true } as never,
      }),
    );
  }

  postMessage(msg: PreviewWorkerInbound): void {
    if (msg.type === 'init') queueMicrotask(() => this.emit({ type: 'initialized' }));
  }

  /** Deliver to `addEventListener` listeners and the `onmessage` handler, once each. */
  emit(data: PreviewWorkerOutbound): void {
    const event = new MessageEvent('message', { data });
    const handler = this.onmessage;
    this.onmessage = null; // happy-dom's dispatchEvent would also call it
    this.dispatchEvent(event);
    this.onmessage = handler;
    handler?.(event);
  }
}

async function createRuntime(): Promise<PreviewWorkerRuntime> {
  const canvas = document.createElement('canvas');
  (canvas as unknown as { transferControlToOffscreen: () => object }).transferControlToOffscreen =
    () => ({});
  const runtime = await PreviewWorkerRuntime.create(canvas, false);
  if (!runtime) throw new Error('runtime did not start');
  return runtime;
}

describe('PreviewWorkerRuntime device state', () => {
  beforeEach(() => {
    __resetGpuContextForTests();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('OffscreenCanvas', class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetGpuContextForTests();
  });

  it('reports the worker device loss and recovery to its listeners and Copy Debug', async () => {
    const runtime = await createRuntime();
    const states: Array<[string, string | undefined]> = [];
    runtime.onDeviceState((state, message) => states.push([state, message]));
    const worker = FakeWorker.last!;

    worker.emit({ type: 'gpu-error', entry: { type: 'validation', message: 'bad bind group', timestamp: 1 } });
    worker.emit({ type: 'gpu-lost', message: 'GPU process crashed', timestamp: 2 });
    worker.emit({ type: 'gpu-recovered' });

    expect(states).toEqual([
      ['lost', 'GPU process crashed'],
      ['recovered', undefined],
    ]);
    expect(getGpuErrorLog()).toEqual([
      expect.objectContaining({ type: 'validation', realm: 'preview-worker' }),
      expect.objectContaining({ type: 'lost', message: 'GPU process crashed', realm: 'preview-worker' }),
    ]);
    runtime.destroy();
  });

  it('reports a failed recreate', async () => {
    const runtime = await createRuntime();
    const listener = vi.fn();
    runtime.onDeviceState(listener);
    FakeWorker.last!.emit({ type: 'gpu-recovery-failed', message: 'adapter gone', timestamp: 3 });
    expect(listener).toHaveBeenCalledWith('failed', 'adapter gone');
    runtime.destroy();
  });
});
