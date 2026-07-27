import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireGpuContext,
  clearGpuErrorLog,
  getGpuErrorLog,
  hasGpuContext,
  onGpuDeviceLost,
  onGpuDeviceRecovered,
  __resetGpuContextForTests,
} from './gpuDevice';

interface FakeDevice {
  lost: Promise<GPUDeviceLostInfo>;
  destroy: ReturnType<typeof vi.fn>;
  onuncapturederror: ((event: { error: Error }) => void) | null;
  queue: unknown;
}

function makeFakeDevice(): { device: FakeDevice; triggerLost: (info: GPUDeviceLostInfo) => void } {
  let resolveLost!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    resolveLost = resolve;
  });
  const device: FakeDevice = {
    lost,
    destroy: vi.fn(),
    onuncapturederror: null,
    queue: {},
  };
  return { device, triggerLost: resolveLost };
}

function makeFakeAdapter(device: FakeDevice, limits: Record<string, number> = {}) {
  return {
    limits,
    requestDevice: vi.fn().mockResolvedValue(device),
  };
}

function stubGpu(adapter: ReturnType<typeof makeFakeAdapter>) {
  const requestAdapter = vi.fn().mockResolvedValue(adapter);
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter,
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  return requestAdapter;
}

async function flushMicrotasks() {
  // The lost -> handleLost -> acquireGpuContext() -> requestAdapter/requestDevice
  // -> recoveredListeners chain hops several microtask ticks; a macrotask
  // boundary reliably drains all of them.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('gpuDevice registry', () => {
  beforeEach(() => {
    __resetGpuContextForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetGpuContextForTests();
  });

  it('acquires a device and returns the same context on subsequent calls', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    const requestAdapter = stubGpu(adapter);

    const first = await acquireGpuContext();
    const second = await acquireGpuContext();

    expect(first).toBe(second);
    expect(first.device).toBe(device);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
    expect(adapter.requestDevice).toHaveBeenCalledTimes(1);
    expect(hasGpuContext()).toBe(true);
  });

  it('shares one in-flight acquisition across concurrent callers', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    const requestAdapter = stubGpu(adapter);

    const [a, b, c] = await Promise.all([
      acquireGpuContext(),
      acquireGpuContext(),
      acquireGpuContext(),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });

  it('clamps requiredLimits to what the adapter reports', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device, {
      maxTextureDimension2D: 2048, // below our 4096 desired value
      maxBufferSize: 1024,
    });
    stubGpu(adapter);

    await acquireGpuContext();

    expect(adapter.requestDevice).toHaveBeenCalledWith({
      requiredLimits: {
        maxTextureDimension2D: 2048,
        maxBufferSize: 1024,
      },
    });
  });

  it('rejects when navigator.gpu is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    await expect(acquireGpuContext()).rejects.toThrow(/WebGPU is not available/);
  });

  it('rejects when no adapter is returned', async () => {
    const requestAdapter = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('navigator', { gpu: { requestAdapter, getPreferredCanvasFormat: () => 'bgra8unorm' } });
    await expect(acquireGpuContext()).rejects.toThrow(/No WebGPU adapter/);
  });

  it('ensure() returns the same context while it is still live', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    stubGpu(adapter);

    const ctx = await acquireGpuContext();
    const ensured = await ctx.ensure();
    expect(ensured).toBe(ctx);
  });

  it('destroy() destroys the device and does not trigger the lost/recreate path', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    stubGpu(adapter);

    const ctx = await acquireGpuContext();
    const lostListener = vi.fn();
    onGpuDeviceLost(lostListener);

    ctx.destroy();
    expect(device.destroy).toHaveBeenCalledTimes(1);
    expect(hasGpuContext()).toBe(false);

    await flushMicrotasks();
    expect(lostListener).not.toHaveBeenCalled();
  });

  it('an unexpected device loss notifies listeners, logs it, and recreates once automatically', async () => {
    const { device: deviceA, triggerLost } = makeFakeDevice();
    const { device: deviceB } = makeFakeDevice();
    const adapter = makeFakeAdapter(deviceA);
    // Second acquireGpuContext() call (triggered by the automatic recreate)
    // should get a fresh device.
    adapter.requestDevice
      .mockResolvedValueOnce(deviceA)
      .mockResolvedValueOnce(deviceB);
    stubGpu(adapter);

    const ctx = await acquireGpuContext();
    expect(ctx.device).toBe(deviceA);

    const lostListener = vi.fn();
    const recoveredListener = vi.fn();
    onGpuDeviceLost(lostListener);
    onGpuDeviceRecovered(recoveredListener);

    triggerLost({ reason: 'unknown', message: 'GPU process crashed' } as GPUDeviceLostInfo);
    await flushMicrotasks();

    expect(lostListener).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'GPU process crashed' }),
    );
    expect(getGpuErrorLog()).toContainEqual(
      expect.objectContaining({ type: 'lost', message: 'GPU process crashed' }),
    );

    // Automatic recreate: a fresh context with a different device.
    expect(recoveredListener).toHaveBeenCalledTimes(1);
    const recovered = recoveredListener.mock.calls[0][0];
    expect(recovered.device).toBe(deviceB);
    expect(recovered).not.toBe(ctx);

    const next = await acquireGpuContext();
    expect(next.device).toBe(deviceB);
  });

  it('onuncapturederror records validation/OOM/internal errors distinctly', async () => {
    class FakeValidationError extends Error {}
    class FakeOomError extends Error {}
    vi.stubGlobal('GPUValidationError', FakeValidationError);
    vi.stubGlobal('GPUOutOfMemoryError', FakeOomError);

    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    stubGpu(adapter);

    await acquireGpuContext();
    clearGpuErrorLog();

    device.onuncapturederror?.({ error: new FakeValidationError('bad bind group') });
    device.onuncapturederror?.({ error: new FakeOomError('out of memory') });
    device.onuncapturederror?.({ error: new Error('mystery failure') });

    const log = getGpuErrorLog();
    expect(log.map((e) => e.type)).toEqual(['validation', 'out-of-memory', 'internal']);
    expect(log[0].message).toBe('bad bind group');
  });

  it('getGpuErrorLog caps at the most recent entries', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    stubGpu(adapter);
    await acquireGpuContext();
    clearGpuErrorLog();

    for (let i = 0; i < 30; i++) {
      device.onuncapturederror?.({ error: new Error(`err-${i}`) });
    }

    const log = getGpuErrorLog();
    expect(log.length).toBeLessThanOrEqual(20);
    expect(log[log.length - 1].message).toBe('err-29');
  });
});
