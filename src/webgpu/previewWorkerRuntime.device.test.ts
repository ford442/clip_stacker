import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewWorkerRuntime } from './previewWorkerRuntime';
import { getGpuErrorLog, __resetGpuContextForTests } from './gpuDevice';
import type { PreviewWorkerProtocol } from './previewWorkerProtocol';
import type { WebGpuProbeResult } from './webgpuProbe';
import { InProcessWorker, flushWorkerMessages } from '../workers/inProcessWorker.test.helpers';
import { exposeWorker, type WorkerPort } from '../workers/workerRpc';

const PROBE_OK: WebGpuProbeResult = { ok: true, browser: 'test', reason: '', adapter: null };

/** Just enough of the preview worker to get through the two-phase handshake. */
class FakePreviewWorker extends InProcessWorker {
  static last: FakePreviewWorker | null = null;
  port: WorkerPort<PreviewWorkerProtocol> | null = null;

  constructor() {
    super();
    FakePreviewWorker.last = this;
    // Only the handshake calls are served; every other message is dropped.
    exposeWorker<Pick<PreviewWorkerProtocol, 'configure' | 'init' | 'gpu-error' | 'gpu-lost' | 'gpu-recovered' | 'gpu-recovery-failed'>>(
      (port) => {
        this.port = port;
        return {
          configure: () => ({ webgpuAvailable: true, webgpuProbe: PROBE_OK }),
          init: () => {},
        };
      },
      { scope: this.scope },
    );
  }
}

async function createRuntime(): Promise<PreviewWorkerRuntime> {
  const canvas = document.createElement('canvas');
  canvas.transferControlToOffscreen = () => new OffscreenCanvas(1, 1);
  const runtime = await PreviewWorkerRuntime.create(canvas, false, () => new FakePreviewWorker());
  if (!runtime) throw new Error('runtime did not start');
  return runtime;
}

describe('PreviewWorkerRuntime device state', () => {
  beforeEach(() => {
    __resetGpuContextForTests();
    // Transferable through structuredClone, like the real OffscreenCanvas.
    vi.stubGlobal('OffscreenCanvas', ArrayBuffer);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetGpuContextForTests();
  });

  it('reports the worker device loss and recovery to its listeners and Copy Debug', async () => {
    const runtime = await createRuntime();
    const states: Array<[string, string | undefined]> = [];
    runtime.onDeviceState((state, message) => states.push([state, message]));
    const port = FakePreviewWorker.last!.port!;

    port.emit('gpu-error', { entry: { type: 'validation', message: 'bad bind group', timestamp: 1 } });
    port.emit('gpu-lost', { message: 'GPU process crashed', timestamp: 2 });
    port.emit('gpu-recovered');
    await flushWorkerMessages();

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
    FakePreviewWorker.last!.port!.emit('gpu-recovery-failed', { message: 'adapter gone', timestamp: 3 });
    await flushWorkerMessages();
    expect(listener).toHaveBeenCalledWith('failed', 'adapter gone');
    runtime.destroy();
  });
});
