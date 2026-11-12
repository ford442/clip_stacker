import { describe, expect, it, vi } from 'vitest';
import { openVideoDemux, readVideoColorSpace, type DemuxPacket, type DemuxStream } from './demux';
import { buildTestMp4, buildTestWebm, ReadLoggingBlob } from './demux.test.helpers';

const counters = vi.hoisted(() => ({ inputs: 0 }));

// Count Mediabunny inputs: one per demux index built.
vi.mock('./mediabunnyDemux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mediabunnyDemux')>();
  class CountingInput extends actual.Input {
    constructor(options: ConstructorParameters<typeof actual.Input>[0]) {
      super(options);
      counters.inputs++;
    }
  }
  return { ...actual, Input: CountingInput };
});

async function take(stream: DemuxStream<DemuxPacket>, count: number): Promise<DemuxPacket[]> {
  const packets: DemuxPacket[] = [];
  while (packets.length < count) {
    const next = await stream.next();
    if (next.done) break;
    packets.push(next.value);
  }
  stream.close();
  return packets;
}

const PQ: VideoColorSpaceInit = {
  primaries: 'bt2020' as VideoColorPrimaries,
  transfer: 'pq' as VideoTransferCharacteristics,
  matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
  fullRange: false,
};

describe('openVideoDemux — MP4', () => {
  it('reads the decoder config from the moov: codec, coded size, avcC description', async () => {
    const demux = await openVideoDemux(new Blob([await buildTestMp4({ width: 640, height: 360, seconds: 2 })]));
    expect(demux.config.codec).toBe('avc1.64001f');
    expect(demux.config.codedWidth).toBe(640);
    expect(demux.config.codedHeight).toBe(360);
    expect(demux.config.description).toBeInstanceOf(Uint8Array);
    expect(demux.config.hardwareAcceleration).toBeUndefined();
    expect(demux.hasAlpha).toBe(false);
  });

  it('builds the index once per Blob and shares it between opens', async () => {
    const bytes = await buildTestMp4({ width: 320, height: 180, seconds: 1 });
    const blob = new Blob([bytes]);
    const before = counters.inputs;

    const [first, second] = await Promise.all([openVideoDemux(blob), openVideoDemux(blob)]);
    const third = await openVideoDemux(blob);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(counters.inputs - before).toBe(1);

    // Same bytes, another Blob: its own index.
    await openVideoDemux(new Blob([bytes]));
    expect(counters.inputs - before).toBe(2);
  });

  it('evicts a failed open, so the next open tries again', async () => {
    const blob = new Blob([new Uint8Array(4096).fill(7)]);
    const before = counters.inputs;
    await expect(openVideoDemux(blob)).rejects.toThrow();
    await expect(openVideoDemux(blob)).rejects.toThrow();
    expect(counters.inputs - before).toBe(2);
  });

  it('starts packets at the last key at or before the start time, timestamps rebased to µs', async () => {
    const demux = await openVideoDemux(
      new Blob([await buildTestMp4({ width: 320, height: 180, seconds: 4, gop: 30 })]),
    );
    const packets = await take(demux.packets(2.5), 4);
    expect(packets.map((p) => p.type)).toEqual(['key', 'delta', 'delta', 'delta']);
    expect(packets[0]!.timestamp).toBe(2_000_000);
    expect(packets[1]!.timestamp).toBe(2_033_333);
    expect(packets[0]!.duration).toBe(33_333);

    // A key exactly at the start is the start, not the one before it.
    expect((await take(demux.packets(3), 1))[0]!.timestamp).toBe(3_000_000);
    // Before the first key: the first key.
    expect((await take(demux.packets(-1), 1))[0]!.timestamp).toBe(0);
  });

  it('a closed stream ends, even with a next() in flight', async () => {
    const demux = await openVideoDemux(new Blob([await buildTestMp4({ width: 320, height: 180, seconds: 2 })]));
    const stream = demux.packets(0);
    const pending = stream.next();
    stream.close();
    await pending;
    expect(await stream.next()).toEqual({ value: undefined, done: true });
  });

  it('reads the index and the packets it needs, never the whole file', async () => {
    // 10 s of 24 KB packets (~7 MB), padded to a 2 GiB "camera file".
    const bytes = await buildTestMp4({ width: 1920, height: 1080, seconds: 10, packetBytes: 24 * 1024 });
    const blob = new ReadLoggingBlob(bytes, 2 * 2 ** 30);

    const demux = await openVideoDemux(blob);
    const indexBytes = blob.log.bytesRead;
    expect(indexBytes).toBeLessThan(512 * 1024);

    blob.log.reset();
    const packets = await take(demux.packets(8.2), 10);
    expect(packets[0]!.timestamp).toBe(8_000_000);
    expect(blob.log.wholeReads).toEqual([]);
    // Ten packets plus read-ahead and 64 KiB page padding — a sliver of the
    // file. (happy-dom's user agent sends Mediabunny down its WebKit path:
    // exact-range `slice().arrayBuffer()` reads instead of a stream reader.)
    expect(blob.log.bytesRead).toBeLessThan(2 * 2 ** 20);
    expect(blob.log.largestRead).toBeLessThanOrEqual(256 * 1024);
  });
});

describe('readVideoColorSpace', () => {
  it('returns the container colour tags and completes them in the decoder config', async () => {
    const blob = new Blob([await buildTestMp4({ width: 1280, height: 720, seconds: 1, colorSpace: PQ })]);
    expect(await readVideoColorSpace(blob)).toEqual(PQ);
    expect((await openVideoDemux(blob)).config.colorSpace).toEqual(PQ);
  });

  it('is null for an untagged file, which keeps colorSpace out of the decoder config', async () => {
    const blob = new Blob([await buildTestMp4({ width: 1280, height: 720, seconds: 1 })]);
    expect(await readVideoColorSpace(blob)).toBeNull();
    expect('colorSpace' in (await openVideoDemux(blob)).config).toBe(false);
  });

  it('is null for a file it cannot demux', async () => {
    expect(await readVideoColorSpace(new Blob(['not a video']))).toBeNull();
  });
});

describe('openVideoDemux — WebM', () => {
  it('demuxes VP8 WebM: config, key packets, timestamps', async () => {
    const demux = await openVideoDemux(
      new Blob([await buildTestWebm({ width: 320, height: 240, frames: 30, gop: 10 })]),
    );
    expect(demux.config.codec).toBe('vp8');
    expect(demux.config.codedWidth).toBe(320);
    expect(demux.config.codedHeight).toBe(240);
    expect(demux.hasAlpha).toBe(false);

    const packets = await take(demux.packets(0.5), 3);
    expect(packets.map((p) => p.type)).toEqual(['key', 'delta', 'delta']);
    expect(packets[0]!.timestamp).toBe(333_000); // frame 10 at 30 fps, on WebM's 1 ms grid
  });

  it('flags a WebM with alpha (AlphaMode + BlockAdditions)', async () => {
    const demux = await openVideoDemux(new Blob([await buildTestWebm({ width: 64, height: 64, alpha: true })]));
    expect(demux.config.codec).toBe('vp8');
    expect(demux.hasAlpha).toBe(true);
  });
});
