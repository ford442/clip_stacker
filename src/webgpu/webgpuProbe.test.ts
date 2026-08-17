import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireGpuContext, __resetGpuContextForTests } from './gpuDevice';
import {
  adapterSnapshot,
  classifyBrowser,
  classifyProbeError,
  getPublishedWebGpuProbe,
  probeWebGpu,
  publishWebGpuProbe,
  __resetWebGpuProbeForTests,
} from './webgpuProbe';

interface FakeDevice {
  lost: Promise<GPUDeviceLostInfo>;
  destroy: ReturnType<typeof vi.fn>;
  onuncapturederror: ((event: { error: Error }) => void) | null;
  queue: unknown;
}

function makeFakeDevice(): FakeDevice {
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  return {
    lost,
    destroy: vi.fn(),
    onuncapturederror: null,
    queue: {},
  };
}

describe('webgpuProbe', () => {
  beforeEach(() => {
    __resetGpuContextForTests();
    __resetWebGpuProbeForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetGpuContextForTests();
    __resetWebGpuProbeForTests();
  });

  it('classifies Chrome vs Edge from the user agent', () => {
    expect(
      classifyBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      ),
    ).toBe('Edge');
    expect(
      classifyBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome');
    expect(classifyBrowser('Mozilla/5.0 Firefox/130')).toBe('other');
  });

  it('maps acquireGpuContext errors to probe reasons', () => {
    expect(classifyProbeError(new Error('WebGPU is not available in this browser'))).toBe(
      'no navigator.gpu',
    );
    expect(classifyProbeError(new Error('No WebGPU adapter available'))).toBe(
      'requestAdapter returned null',
    );
    expect(classifyProbeError(new Error('Failed to create device'))).toBe(
      'requestDevice rejected: Failed to create device',
    );
  });

  it('returns ok with adapter snapshot when acquire succeeds', async () => {
    const device = makeFakeDevice();
    const adapter = {
      limits: {},
      requestDevice: vi.fn().mockResolvedValue(device),
      info: { vendor: 'swiftshader', architecture: '', device: '', description: 'SwiftShader' },
    };
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(adapter),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    });

    const probe = await probeWebGpu();
    expect(probe.ok).toBe(true);
    expect(probe.browser).toBe('Chrome');
    expect(probe.reason).toBe('ok');
    expect(probe.adapter).toEqual({ vendor: 'swiftshader', description: 'SwiftShader' });
    expect(adapterSnapshot(adapter as unknown as GPUAdapter)).toEqual({
      vendor: 'swiftshader',
      description: 'SwiftShader',
    });
    await acquireGpuContext();
    expect(adapter.requestDevice).toHaveBeenCalledTimes(1);
  });

  it('reports no navigator.gpu', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/1' });
    const probe = await probeWebGpu();
    expect(probe).toMatchObject({
      ok: false,
      browser: 'Chrome',
      reason: 'no navigator.gpu',
      adapter: null,
    });
  });

  it('reports null adapter', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/1 Edg/1',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(null),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    });
    const probe = await probeWebGpu();
    expect(probe.ok).toBe(false);
    expect(probe.browser).toBe('Edge');
    expect(probe.reason).toBe('requestAdapter returned null');
  });

  it('reports requestDevice rejection', async () => {
    const adapter = {
      limits: {},
      requestDevice: vi.fn().mockRejectedValue(new Error('operation failed')),
    };
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/1',
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue(adapter),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    });
    const probe = await probeWebGpu();
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain('requestDevice rejected');
    expect(probe.reason).toContain('operation failed');
  });

  it('publishes main and worker probes onto window.webgpuProbe', () => {
    const main = {
      ok: true,
      browser: 'Chrome',
      reason: 'ok',
      adapter: { vendor: 'a' },
    };
    const worker = {
      ok: false,
      browser: 'Edge',
      reason: 'requestAdapter returned null',
      adapter: null,
    };
    publishWebGpuProbe('main', main);
    publishWebGpuProbe('worker', worker);
    expect(getPublishedWebGpuProbe()).toEqual({ main, worker });
    expect(
      (window as Window & { webgpuProbe?: unknown }).webgpuProbe,
    ).toEqual({ main, worker });
  });
});
