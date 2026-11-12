import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGpuProfilerForTests,
  blendProfileSample,
  formatGpuProfile,
  getGpuProfileSnapshot,
  gpuProfilerFor,
  installGpuProfiler,
  onGpuProfile,
  requestGpuProfiling,
  spanDurationsMs,
} from './gpuProfiler';

function fakeDevice(features: string[] = ['timestamp-query']) {
  let resolveMap: () => void = () => undefined;
  let mapped = new BigUint64Array(96);
  const passes: Array<{ timestampWrites?: { beginningOfPassWriteIndex?: number } }> = [];
  const device = {
    features: new Set(features),
    createQuerySet: vi.fn(() => ({ destroy: vi.fn() })),
    createBuffer: vi.fn(() => ({
      destroy: vi.fn(),
      mapAsync: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveMap = resolve;
          }),
      ),
      getMappedRange: vi.fn(() => mapped.buffer),
      unmap: vi.fn(),
    })),
    createCommandEncoder: vi.fn(() => ({
      resolveQuerySet: vi.fn(),
      copyBufferToBuffer: vi.fn(),
      finish: () => ({}),
    })),
    queue: { submit: vi.fn() },
  };
  const encoder = {
    beginComputePass: (desc: (typeof passes)[number]) => {
      passes.push(desc);
      return { end: vi.fn() };
    },
  } as unknown as GPUCommandEncoder;
  return {
    device: device as unknown as GPUDevice,
    encoder,
    passes,
    setTimestamps: (values: bigint[]) => {
      mapped = new BigUint64Array(96);
      mapped.set(values);
    },
    settle: async () => {
      resolveMap();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 0x200 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
});

afterEach(() => {
  __resetGpuProfilerForTests();
  vi.unstubAllGlobals();
});

describe('gpu profile maths', () => {
  it('turns timestamp pairs into milliseconds and adds up repeated labels', () => {
    const spans = [
      { label: 'bloom', begin: 0, end: 1 },
      { label: 'transition', begin: 2, end: 3 },
      { label: 'bloom', begin: 4, end: 5 },
    ];
    const ts = new BigUint64Array([0n, 1_500_000n, 2_000_000n, 2_250_000n, 3_000_000n, 3_300_000n]);
    const out = spanDurationsMs(spans, ts);
    expect(out.bloom).toBeCloseTo(1.8, 9);
    expect(out.transition).toBeCloseTo(0.25, 9);
  });

  it('skips reversed (reset) pairs', () => {
    const out = spanDurationsMs([{ label: 'x', begin: 0, end: 1 }], new BigInt64Array([5n, 1n]));
    expect(out).toEqual({});
  });

  it('averages with an EMA, taking the first sample as is', () => {
    expect(blendProfileSample(undefined, 4)).toBe(4);
    expect(blendProfileSample(4, 9)).toBeCloseTo(5, 12);
  });

  it('formats slowest first, with an optional limit', () => {
    const snapshot = { bloom: 1.8, 'NR nlm': 6.21, compositor: 0.4 };
    expect(formatGpuProfile(snapshot)).toBe('NR nlm 6.2 ms · bloom 1.8 ms · compositor 0.4 ms');
    expect(formatGpuProfile(snapshot, 2)).toBe('NR nlm 6.2 ms · bloom 1.8 ms');
  });
});

describe('installGpuProfiler', () => {
  it('stays off unless profiling was requested', () => {
    const { device } = fakeDevice();
    installGpuProfiler(device);
    expect(gpuProfilerFor(device)).toBeNull();
  });

  it('stays off when the device did not adopt timestamp-query', () => {
    requestGpuProfiling(true);
    const { device } = fakeDevice([]);
    installGpuProfiler(device);
    expect(gpuProfilerFor(device)).toBeNull();
  });

  it('only answers for the device it was installed on', () => {
    requestGpuProfiling(true);
    const a = fakeDevice();
    const b = fakeDevice();
    installGpuProfiler(a.device);
    expect(gpuProfilerFor(a.device)).not.toBeNull();
    expect(gpuProfilerFor(b.device)).toBeNull();
  });

  it('records spans as empty passes with timestamp writes and reports averages', async () => {
    requestGpuProfiling(true);
    const fake = fakeDevice();
    installGpuProfiler(fake.device);
    const profiler = gpuProfilerFor(fake.device)!;
    const seen: Array<Record<string, number>> = [];
    onGpuProfile((snapshot) => seen.push(snapshot));

    profiler.span(fake.encoder, 'compositor', () => undefined);
    const handle = profiler.begin(fake.encoder, 'bloom');
    profiler.end(fake.encoder, handle);
    expect(fake.passes.map((p) => p.timestampWrites?.beginningOfPassWriteIndex)).toEqual([0, 1, 2, 3]);

    fake.setTimestamps([0n, 400_000n, 400_000n, 2_200_000n]);
    profiler.endFrame();
    await fake.settle();
    expect(seen).toHaveLength(1);
    expect(getGpuProfileSnapshot().compositor).toBeCloseTo(0.4, 9);
    expect(getGpuProfileSnapshot().bloom).toBeCloseTo(1.8, 9);
  });

  it('skips a frame rather than stalling when every readback slot is mapping', () => {
    requestGpuProfiling(true);
    const fake = fakeDevice();
    installGpuProfiler(fake.device);
    const profiler = gpuProfilerFor(fake.device)!;
    const submit = (fake.device.queue.submit as ReturnType<typeof vi.fn>);
    for (let frame = 0; frame < 5; frame++) {
      profiler.span(fake.encoder, 'compositor', () => undefined);
      profiler.endFrame();
    }
    expect(submit).toHaveBeenCalledTimes(3);
  });
});
