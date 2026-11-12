import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i420Layout } from '../finishing/yuvPack';
import { HDR10_COLOR_SPACE } from '../finishing/colorManagement';
import { HDR10_FRAME_FORMAT, Hdr10FrameReader, packedFrameInit } from './hdr10FrameReader';
import { ReadbackRing, ReadbackRingFullError } from './readbackRing';
import { yuvPackDispatchSize, packYuvUniforms } from './yuvPackPass';

interface FakeBuffer {
  size: number;
  usage: number;
  destroyed: boolean;
  mapAsync: ReturnType<typeof vi.fn>;
  getMappedRange: ReturnType<typeof vi.fn>;
  unmap: ReturnType<typeof vi.fn>;
  destroy: () => void;
  resolveMap: () => void;
}

/** A GPUDevice double that counts every allocation and lets a test settle maps by hand. */
function fakeDevice() {
  const buffers: FakeBuffer[] = [];
  const pendingMaps: FakeBuffer[] = [];
  const counts = { buffers: 0, bindGroups: 0, encoders: 0, submits: 0, dispatches: [] as number[][] };
  const device = {
    createBuffer: vi.fn((desc: { size: number; usage: number }) => {
      counts.buffers++;
      let resolveMap: () => void = () => undefined;
      const buffer: FakeBuffer = {
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        mapAsync: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveMap = resolve;
              pendingMaps.push(buffer);
            }),
        ),
        getMappedRange: vi.fn(() => new ArrayBuffer(desc.size)),
        unmap: vi.fn(),
        destroy: () => {
          buffer.destroyed = true;
        },
        resolveMap: () => resolveMap(),
      };
      buffers.push(buffer);
      return buffer;
    }),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createBindGroup: vi.fn(() => {
      counts.bindGroups++;
      return {};
    }),
    createCommandEncoder: vi.fn(() => {
      counts.encoders++;
      return {
        beginComputePass: () => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          dispatchWorkgroups: (...args: number[]) => counts.dispatches.push(args),
          end: vi.fn(),
        }),
        copyBufferToBuffer: vi.fn(),
        finish: () => ({}),
      };
    }),
    queue: {
      submit: vi.fn(() => {
        counts.submits++;
      }),
      writeBuffer: vi.fn(),
    },
  };
  /** Settle the oldest outstanding map and let its consumer run. */
  const settleOldest = async () => {
    const buffer = pendingMaps.shift();
    buffer?.resolveMap();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { device: device as unknown as GPUDevice, buffers, counts, settleOldest };
}

const texture = (width: number, height: number) =>
  ({ width, height, createView: () => ({}) }) as unknown as GPUTexture;

class FakeVideoFrame {
  constructor(
    readonly data: Uint8Array,
    readonly init: VideoFrameBufferInit,
  ) {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('GPUBufferUsage', {
    MAP_READ: 0x1,
    COPY_SRC: 0x4,
    COPY_DST: 0x8,
    UNIFORM: 0x40,
    STORAGE: 0x80,
  });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  vi.stubGlobal('VideoFrame', FakeVideoFrame);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Hdr10FrameReader', () => {
  it('allocates no GPU buffers or bind groups per frame in a steady export', async () => {
    const { device, counts, settleOldest } = fakeDevice();
    const reader = new Hdr10FrameReader(device);
    const pq = texture(320, 180);
    const pending: Promise<VideoFrame>[] = [];

    const capture = (frame: number) => {
      pending.push(reader.capture(pq, { timestamp: frame * 33_333 }));
    };
    // Prime the ring, then keep it full like the export loop does.
    for (let frame = 0; frame < reader.depth; frame++) capture(frame);
    const primed = { buffers: counts.buffers, bindGroups: counts.bindGroups };

    for (let frame = reader.depth; frame < 120; frame++) {
      expect(reader.hasFreeSlot).toBe(false);
      await settleOldest();
      capture(frame);
    }
    while (pending.length < 120) await settleOldest();
    for (let i = 0; i < reader.depth; i++) await settleOldest();

    // Uniforms + pack output + one staging buffer per ring slot, once.
    expect(primed.buffers).toBe(2 + reader.depth);
    expect(counts.buffers).toBe(primed.buffers);
    expect(counts.bindGroups).toBe(primed.bindGroups);
    expect(counts.submits).toBe(120);

    const frames = await Promise.all(pending);
    expect(frames).toHaveLength(120);
    expect(frames.map((f) => (f as unknown as FakeVideoFrame).init.timestamp)).toEqual(
      Array.from({ length: 120 }, (_, i) => i * 33_333),
    );
    reader.destroy();
  });

  it('builds I420P10 frames tagged HDR10 with the packed plane layout', async () => {
    const { device, settleOldest } = fakeDevice();
    const reader = new Hdr10FrameReader(device);
    const promise = reader.capture(texture(6, 4), { timestamp: 10, duration: 33 });
    await settleOldest();
    const frame = (await promise) as unknown as FakeVideoFrame;
    const layout = i420Layout(6, 4, 'i420p10-bt2020');
    expect(frame.data.byteLength).toBe(layout.dataBytes);
    expect(frame.init).toEqual(
      packedFrameInit(layout, { timestamp: 10, duration: 33 }, HDR10_COLOR_SPACE as VideoColorSpaceInit, 'I420P10'),
    );
    expect(frame.init.format).toBe(HDR10_FRAME_FORMAT);
    expect(frame.init.colorSpace).toEqual(HDR10_COLOR_SPACE);
    reader.destroy();
  });

  it('reallocates only when the frame size changes', async () => {
    const { device, counts, settleOldest } = fakeDevice();
    const reader = new Hdr10FrameReader(device);
    const first = reader.capture(texture(320, 180), { timestamp: 0 });
    await settleOldest();
    await first;
    const afterFirst = counts.buffers;
    const second = reader.capture(texture(640, 360), { timestamp: 1 });
    await settleOldest();
    await second;
    // New pack output + the next ring slot's staging buffer.
    expect(counts.buffers).toBe(afterFirst + 2);
    reader.destroy();
  });
});

describe('ReadbackRing', () => {
  it('throws instead of allocating when every slot is in flight', () => {
    const { device, counts } = fakeDevice();
    const ring = new ReadbackRing(device, 2);
    const source = {} as GPUBuffer;
    void ring.readback(() => source, 16, () => 1);
    void ring.readback(() => source, 16, () => 2);
    expect(ring.inFlight).toBe(2);
    expect(() => ring.readback(() => source, 16, () => 3)).toThrow(ReadbackRingFullError);
    expect(counts.buffers).toBe(2);
  });

  it('frees a slot after consume and resolves waitForSlot', async () => {
    const { device, settleOldest } = fakeDevice();
    const ring = new ReadbackRing(device, 1);
    const result = ring.readback(() => ({}) as GPUBuffer, 8, (bytes) => bytes.byteLength);
    const waiting = ring.waitForSlot();
    await settleOldest();
    await waiting;
    expect(await result).toBe(8);
    expect(ring.hasFreeSlot).toBe(true);
  });

  it('rounds the copy up to whole words', async () => {
    const { device, buffers, settleOldest } = fakeDevice();
    const ring = new ReadbackRing(device, 1);
    const result = ring.readback(() => ({}) as GPUBuffer, 27, () => null);
    await settleOldest();
    await result;
    expect(buffers[0]!.size).toBe(28);
  });
});

describe('yuvPackPass helpers', () => {
  it('dispatches one invocation per word, going 2D past 65535 workgroups', () => {
    expect(yuvPackDispatchSize(1)).toEqual([1, 1]);
    expect(yuvPackDispatchSize(64 * 65535)).toEqual([65535, 1]);
    // 4K I420P10: 3840·2160·1.5 samples / 2 per word.
    const words = (3840 * 2160 * 3) / 4;
    const [x, y] = yuvPackDispatchSize(words);
    expect(x).toBe(65535);
    expect(x * y * 64).toBeGreaterThanOrEqual(words);
  });

  it('packs the uniform block the shader reads', () => {
    const layout = i420Layout(6, 4, 'i420p10-bt2020');
    expect(Array.from(packYuvUniforms(layout, 'i420p10-bt2020'))).toEqual([
      6, 4, 3, 2, 36, 18, 0, 0,
    ]);
    expect(packYuvUniforms(i420Layout(6, 4, 'i420-bt709'), 'i420-bt709')[6]).toBe(1);
  });
});
