import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_RECOVERY_BACKOFF_MS,
  FallbackAdapterError,
  MAX_DEVICE_RECOVERY_ATTEMPTS,
  acquireGpuContext,
  allowFallbackAdapterForPreview,
  assertPreviewAdapter,
  clearGpuErrorLog,
  probeGpuAdapter,
  requestedOptionalFeatures,
  getGpuErrorLog,
  hasGpuContext,
  peekGpuDevice,
  onGpuDeviceLost,
  onGpuDeviceRecovered,
  onGpuDeviceRecoveryFailed,
  onGpuError,
  recordRemoteGpuError,
  __resetGpuContextForTests,
} from './gpuDevice';
import { __resetGpuProfilerForTests, gpuProfilerFor, requestGpuProfiling } from './gpuProfiler';

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

function makeFakeAdapter(
  device: FakeDevice,
  limits: Record<string, number> = {},
  features: string[] = [],
  info: { isFallbackAdapter?: boolean } = {},
) {
  return {
    limits,
    features: new Set(features),
    info,
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetGpuContextForTests();
    __resetGpuProfilerForTests();
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
    expect(peekGpuDevice()).toBe(device);
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
      maxTextureDimension2D: 2048, // below our 16384 desired value
      maxBufferSize: 1024,
    });
    stubGpu(adapter);

    await acquireGpuContext();

    expect(adapter.requestDevice).toHaveBeenCalledWith({
      requiredLimits: {
        maxTextureDimension2D: 2048,
        maxBufferSize: 1024,
      },
      requiredFeatures: [],
      label: 'clip_stacker-preview',
      defaultQueue: { label: 'clip_stacker-preview-queue' },
    });
  });

  it('requests only the features a code path reads', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device, {}, [
      'timestamp-query',
      'float32-filterable',
      'rg11b10ufloat-renderable',
      'shader-f16',
      'texture-compression-bc',
    ]);
    stubGpu(adapter);

    const ctx = await acquireGpuContext();

    expect(adapter.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ requiredFeatures: ['shader-f16'] }),
    );
    expect([...ctx.features]).toEqual(['shader-f16']);
  });

  it('adds timestamp-query only under ?gpu_profile, and installs the profiler', async () => {
    expect(requestedOptionalFeatures(false)).not.toContain('timestamp-query');
    expect(requestedOptionalFeatures(true)).toContain('timestamp-query');

    requestGpuProfiling(true);
    const device = { ...makeFakeDevice().device, features: new Set(['timestamp-query']) };
    const fakeBuffer = { destroy: vi.fn() };
    Object.assign(device, {
      createQuerySet: vi.fn(() => ({ destroy: vi.fn() })),
      createBuffer: vi.fn(() => fakeBuffer),
    });
    vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 0x200 });
    const adapter = makeFakeAdapter(device, {}, ['timestamp-query', 'shader-f16']);
    stubGpu(adapter);

    const ctx = await acquireGpuContext();
    expect(adapter.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ requiredFeatures: ['shader-f16', 'timestamp-query'] }),
    );
    expect(gpuProfilerFor(ctx.device)).not.toBeNull();
  });

  it('flags a fallback adapter and refuses it for live preview unless allowed', async () => {
    const { device } = makeFakeDevice();
    stubGpu(makeFakeAdapter(device, {}, [], { isFallbackAdapter: true }));

    const ctx = await acquireGpuContext();
    expect(ctx.isFallbackAdapter).toBe(true);
    expect(() => assertPreviewAdapter(ctx)).toThrow(FallbackAdapterError);
    allowFallbackAdapterForPreview(true);
    expect(() => assertPreviewAdapter(ctx)).not.toThrow();
    expect(() => assertPreviewAdapter({ isFallbackAdapter: false })).not.toThrow();
  });

  it('reads the older GPUAdapter.isFallbackAdapter too', async () => {
    const { device } = makeFakeDevice();
    const adapter = { ...makeFakeAdapter(device), info: undefined, isFallbackAdapter: true };
    stubGpu(adapter as unknown as ReturnType<typeof makeFakeAdapter>);
    expect((await acquireGpuContext()).isFallbackAdapter).toBe(true);
  });

  it('the adapter probe requests no device, and the first acquire reuses its adapter', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    const requestAdapter = stubGpu(adapter);

    expect(await probeGpuAdapter()).toBe(adapter);
    expect(await probeGpuAdapter()).toBe(adapter);
    expect(adapter.requestDevice).not.toHaveBeenCalled();
    expect(hasGpuContext()).toBe(false);

    const ctx = await acquireGpuContext();
    expect(ctx.adapter).toBe(adapter);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });

  it('never requires an optional feature the adapter lacks (boots with an empty feature set)', async () => {
    const { device } = makeFakeDevice();
    const adapter = makeFakeAdapter(device, {}, []);
    stubGpu(adapter);

    const ctx = await acquireGpuContext();

    expect(adapter.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ requiredFeatures: [] }),
    );
    expect(ctx.features.size).toBe(0);
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

  it('an unexpected device loss notifies listeners, logs it, and recreates after a backoff', async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(DEVICE_RECOVERY_BACKOFF_MS[0] - 1);
    expect(recoveredListener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

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

  it('retries a failed recreate with a growing backoff, then reports failure once', async () => {
    vi.useFakeTimers();
    const { device, triggerLost } = makeFakeDevice();
    const adapter = makeFakeAdapter(device);
    adapter.requestDevice
      .mockResolvedValueOnce(device)
      .mockRejectedValue(new Error('adapter gone'));
    stubGpu(adapter);
    await acquireGpuContext();

    const failed = vi.fn();
    const recovered = vi.fn();
    onGpuDeviceRecoveryFailed(failed);
    onGpuDeviceRecovered(recovered);
    triggerLost({ reason: 'unknown', message: 'driver reset' } as GPUDeviceLostInfo);

    expect(DEVICE_RECOVERY_BACKOFF_MS).toEqual([250, 500, 1000, 2000, 4000]);
    let attempts = 1;
    for (const delay of DEVICE_RECOVERY_BACKOFF_MS) {
      await vi.advanceTimersByTimeAsync(delay);
      attempts++;
      expect(adapter.requestDevice).toHaveBeenCalledTimes(attempts);
    }
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/gave up after 5/) }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.requestDevice).toHaveBeenCalledTimes(1 + MAX_DEVICE_RECOVERY_ATTEMPTS);
    expect(recovered).not.toHaveBeenCalled();
  });

  it('caps a device that keeps dying right after each recreate', async () => {
    vi.useFakeTimers();
    const devices = Array.from({ length: 8 }, () => makeFakeDevice());
    const adapter = makeFakeAdapter(devices[0]!.device);
    for (const { device } of devices) adapter.requestDevice.mockResolvedValueOnce(device);
    stubGpu(adapter);
    await acquireGpuContext();

    const failed = vi.fn();
    const recovered = vi.fn();
    onGpuDeviceRecoveryFailed(failed);
    onGpuDeviceRecovered(recovered);
    for (let loss = 0; loss <= MAX_DEVICE_RECOVERY_ATTEMPTS; loss++) {
      devices[loss]!.triggerLost({ reason: 'unknown', message: `loss ${loss}` } as GPUDeviceLostInfo);
      await vi.advanceTimersByTimeAsync(4000);
    }
    expect(recovered).toHaveBeenCalledTimes(MAX_DEVICE_RECOVERY_ATTEMPTS);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(adapter.requestDevice).toHaveBeenCalledTimes(1 + MAX_DEVICE_RECOVERY_ATTEMPTS);
  });

  it('onGpuError sees this realm\'s errors; remote entries are logged without echoing', async () => {
    const { device } = makeFakeDevice();
    stubGpu(makeFakeAdapter(device));
    await acquireGpuContext();
    const listener = vi.fn();
    onGpuError(listener);

    device.onuncapturederror?.({ error: new Error('local failure') });
    recordRemoteGpuError({
      type: 'validation',
      message: 'worker failure',
      timestamp: 1,
      realm: 'preview-worker',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ message: 'local failure' }));
    expect(getGpuErrorLog()).toContainEqual(
      expect.objectContaining({ message: 'worker failure', realm: 'preview-worker' }),
    );
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
