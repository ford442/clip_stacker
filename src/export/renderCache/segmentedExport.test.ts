import { describe, expect, it } from 'vitest';
import type { Clip, TextOverlay } from '../../types';
import { buildPreviewCompositionPlan } from '../../composition/previewComposition';
import { createTestClip } from '../../project/project.test.helpers';
import { quantizePlan } from '../renderKey';
import { createMemoryCacheBackend } from './cacheBackend';
import { RenderCache } from './renderCache';
import {
  runSegmentedExport,
  SegmentConfigMismatchError,
  type CopySource,
  type SegmentedExportDeps,
} from './segmentedExport';
import type { SegmentDecoderConfig, SegmentPacket } from './segmentRecord';
import { parseAvcDecoderConfig, type SourcePacket } from './smartRender';

const FRAME = 33_333;
const FPS = 30;

function avcC(id: number): Uint8Array {
  return new Uint8Array([1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, id, 1, 0, 2, 0x68, id]);
}
const ENCODER_DESC = avcC(1);
const SOURCE_DESC = avcC(2);

function clip(id: string, duration: number): Clip {
  return { ...createTestClip(id, duration), videoWidth: 640, videoHeight: 360 };
}

/** A title keyframed visible only between `from` and `to`. */
function title(text: string, from: number, to: number): TextOverlay {
  return {
    id: 't1',
    text,
    x: 0.1,
    y: 0.1,
    fontsize: 32,
    fontcolor: '#ffffff',
    scrolling: false,
    scrollSpeed: 0,
    keyframes: {
      opacity: [
        { t: 0, value: 0 },
        { t: from - 0.001, value: 0 },
        { t: from, value: 1 },
        { t: to, value: 1 },
        { t: to + 0.001, value: 0 },
      ],
    },
  } as TextOverlay;
}

interface Recorded {
  packet: { data: Uint8Array; type: 'key' | 'delta'; timestamp: number; duration: number };
  meta?: EncodedVideoChunkMetadata | undefined;
}

function encoderConfig(description = ENCODER_DESC, codec = 'avc1.42001f'): SegmentDecoderConfig {
  return { codec, codedWidth: 640, codedHeight: 360, description };
}

interface Harness {
  deps: SegmentedExportDeps;
  encoded: Array<[number, number]>;
  probes: number;
  sink: Recorded[];
}

function harness(
  clips: Clip[],
  overlays: TextOverlay[],
  options: {
    cache?: RenderCache | null;
    encoder?: SegmentDecoderConfig;
    probe?: SegmentDecoderConfig;
    source?: CopySource | null;
    mediaKey?: (clip: Clip) => string | null;
  } = {},
): Harness {
  const h: Harness = { encoded: [], probes: 0, sink: [], deps: null as never };
  const totalDuration = clips.reduce((sum, c) => sum + c.duration, 0);
  const encoder = options.encoder ?? encoderConfig();
  h.deps = {
    totalFrames: Math.round(totalDuration * FPS),
    frameDurationUs: FRAME,
    width: 640,
    height: 360,
    planFor: (i) =>
      quantizePlan(
        buildPreviewCompositionPlan(clips, [], [], overlays, { outputResolution: '640x360' }, i / FPS, 360, 640),
      ),
    keyContext: {
      clipsById: new Map(clips.map((c) => [c.id, c])),
      mediaKey: options.mediaKey ?? ((c) => `media-${c.file.name}`),
      settingsHash: 'settings',
    },
    frameSeeded: false,
    settingsKey: 'enc',
    cache: options.cache === undefined ? new RenderCache(createMemoryCacheBackend()) : options.cache,
    smartRender:
      options.source === undefined
        ? null
        : { blockers: [], openSource: async () => options.source ?? null },
    encodeRange: async (start, end, onFrame) => {
      h.encoded.push([start, end]);
      const packets: SegmentPacket[] = [];
      for (let i = start; i < end; i++) {
        onFrame();
        packets.push({
          type: i === start ? 'key' : 'delta',
          timestamp: i * FRAME,
          duration: FRAME,
          data: new Uint8Array([0, 0, 0, 2, 0x65, i & 0xff]),
        });
      }
      return { packets, config: encoder };
    },
    probeEncoderConfig: async () => {
      h.probes += 1;
      return options.probe ?? encoder;
    },
    sink: {
      addVideoPacket: (packet, meta) => h.sink.push({ packet: { ...packet, data: packet.data.slice() }, meta }),
      throwIfFailed: () => undefined,
    },
    onProgress: () => undefined,
    onStatus: () => undefined,
  };
  return h;
}

function sourceOf(keysEvery: number, frames: number): CopySource {
  const packets: SourcePacket[] = Array.from({ length: frames }, (_, i) => ({
    type: i % keysEvery === 0 ? 'key' : 'delta',
    timestamp: i * FRAME,
    duration: FRAME,
    data: new Uint8Array([0, 0, 0, 2, 0x41, i & 0xff]),
  }));
  return {
    source: {
      config: { codec: 'avc1.64001e', codedWidth: 640, codedHeight: 360, description: SOURCE_DESC },
      colorSpace: null,
    },
    readPackets: async (startUs, endUs) => {
      const keyBefore = packets.filter((p) => p.type === 'key' && p.timestamp <= startUs).at(-1)!;
      return packets.filter((p) => p.timestamp >= keyBefore.timestamp && p.timestamp < endUs + 1_000_000);
    },
  };
}

const framesOf = (ranges: Array<[number, number]>) => ranges.reduce((n, [a, b]) => n + b - a, 0);

describe('runSegmentedExport — render cache', () => {
  it('a warm export reuses every segment and writes the same packets as the cold one', async () => {
    const cache = new RenderCache(createMemoryCacheBackend());
    const clips = [clip('a', 3), clip('b', 2)];
    const cold = harness(clips, [], { cache });
    const coldReport = await runSegmentedExport(cold.deps);
    expect(coldReport).toMatchObject({ hits: 0, framesEncoded: 150, framesReused: 0 });
    expect(coldReport.misses).toBe(coldReport.segments);
    expect(cache.usage().entries).toBe(coldReport.segments);

    const warm = harness(clips, [], { cache });
    const warmReport = await runSegmentedExport(warm.deps);
    expect(warm.encoded).toEqual([]);
    expect(warm.probes).toBe(0);
    expect(warmReport).toMatchObject({ hits: coldReport.segments, misses: 0, framesReused: 150, framesEncoded: 0 });
    expect(warm.sink).toEqual(cold.sink);
    expect(warm.sink[0]!.meta?.decoderConfig?.codec).toBe('avc1.42001f');
    expect(warmReport.reasons.join('\n')).toMatch(/reused/);
  });

  it('segments start on key frames and never exceed the GOP', async () => {
    const h = harness([clip('a', 5)], []);
    await runSegmentedExport(h.deps);
    expect(h.encoded.every(([a, b]) => b - a <= 60)).toBe(true);
    expect(h.sink.filter((r) => r.packet.type === 'key').map((r) => r.packet.timestamp / FRAME)).toEqual([0, 60, 120]);
  });

  it('editing a title re-encodes only the segments it covers', async () => {
    const cache = new RenderCache(createMemoryCacheBackend());
    const clips = [clip('a', 4)];
    await runSegmentedExport(harness(clips, [title('Hello', 1, 2)], { cache }).deps);
    const edited = harness(clips, [title('World', 1, 2)], { cache });
    const report = await runSegmentedExport(edited.deps);
    expect(edited.encoded).toEqual([[30, 61]]);
    expect(report.framesEncoded).toBe(31);
    expect(report.framesReused).toBe(120 - 31);
  });

  it('a rippled clip is reused at its new position, rebased', async () => {
    const cache = new RenderCache(createMemoryCacheBackend());
    const a = clip('a', 2);
    const b = clip('b', 2);
    await runSegmentedExport(harness([a, b], [], { cache }).deps);
    const shorter = { ...a, trimEnd: 1 };
    const rippled = harness([shorter, b], [], { cache });
    const report = await runSegmentedExport(rippled.deps);
    expect(report.framesReused).toBe(60); // all of b
    const bKeys = rippled.sink.filter((r) => r.packet.type === 'key').map((r) => r.packet.timestamp / FRAME);
    expect(bKeys).toContain(30);
  });

  it('renders without storing when nothing can be keyed, or without a cache', async () => {
    const unkeyed = harness([clip('a', 1)], [], { mediaKey: () => null });
    const report = await runSegmentedExport(unkeyed.deps);
    expect(report).toMatchObject({ uncacheable: 1, misses: 1, bytesStored: 0 });
    const uncached = harness([clip('a', 1)], [], { cache: null });
    expect(await runSegmentedExport(uncached.deps)).toMatchObject({ misses: 1, framesEncoded: 30 });
  });

  it('re-renders HEVC hits from another encoder configuration', async () => {
    const cache = new RenderCache(createMemoryCacheBackend());
    const clips = [clip('a', 2)];
    const hevc = (id: number) => encoderConfig(avcC(id), 'hvc1.1.6.L93.B0');
    await runSegmentedExport(harness(clips, [title('x', 1, 1.5)], { cache, encoder: hevc(1) }).deps);
    const changed = harness(clips, [title('y', 1, 1.5)], { cache, encoder: hevc(2) });
    const report = await runSegmentedExport(changed.deps);
    expect(report.parameterSets).toBe('single');
    expect(report.hits).toBe(0);
    expect(framesOf(changed.encoded)).toBe(60);
    expect(report.reasons.join('\n')).toMatch(/another encoder configuration/);
  });

  it('refuses to mix parameter sets the file did not plan for', async () => {
    const cache = new RenderCache(createMemoryCacheBackend());
    const clips = [clip('a', 2)];
    await runSegmentedExport(harness(clips, [title('x', 1, 1.5)], { cache }).deps);
    // The probe says the encoder matches the cache, but the real segments differ.
    const liar = harness(clips, [title('y', 1, 1.5)], {
      cache,
      probe: encoderConfig(),
      encoder: encoderConfig(avcC(9)),
    });
    await expect(runSegmentedExport(liar.deps)).rejects.toBeInstanceOf(SegmentConfigMismatchError);
  });
});

describe('runSegmentedExport — smart render', () => {
  it('copies an untouched clip without encoding or probing', async () => {
    const h = harness([clip('a', 2)], [], { source: sourceOf(30, 60), cache: null });
    const report = await runSegmentedExport(h.deps);
    expect(h.encoded).toEqual([]);
    expect(h.probes).toBe(0);
    expect(report).toMatchObject({ copies: 1, framesCopied: 60, framesEncoded: 0, parameterSets: 'single' });
    expect(h.sink[0]!.meta?.decoderConfig?.codec).toBe('avc1.64001e');
    expect(h.sink.map((r) => r.packet.data[5])).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it('re-encodes around a title and the head of a GOP, writing avc3 with in-band parameter sets', async () => {
    const h = harness([clip('a', 4)], [title('Hi', 1, 2)], { source: sourceOf(30, 120), cache: null });
    const report = await runSegmentedExport(h.deps);
    // [0,30) copied; [30,61) has the title; [61,90) waits for the key frame at 90; [90,120) copied.
    expect(h.encoded).toEqual([
      [30, 61],
      [61, 90],
    ]);
    expect(report).toMatchObject({ copies: 2, framesCopied: 60, framesEncoded: 60, parameterSets: 'in-band' });
    expect(h.sink[0]!.meta?.decoderConfig?.codec).toBe('avc3.64001e');
    const keys = h.sink.filter((r) => r.packet.type === 'key');
    const sourceSets = parseAvcDecoderConfig(SOURCE_DESC)!;
    const encoderSets = parseAvcDecoderConfig(ENCODER_DESC)!;
    // Every key frame carries its own span's SPS (NAL after the 4-byte length).
    expect(keys.map((r) => r.packet.data[5])).toEqual([
      sourceSets.sps[0]![1],
      encoderSets.sps[0]![1],
      encoderSets.sps[0]![1],
      sourceSets.sps[0]![1],
    ]);
    expect(report.reasons.join('\n')).toMatch(/inside a source GOP/);
  });

  it('stays avc1 when the encoder writes the same parameter sets as the source', async () => {
    const h = harness([clip('a', 4)], [title('Hi', 1, 2)], {
      source: sourceOf(30, 120),
      cache: null,
      encoder: encoderConfig(SOURCE_DESC, 'avc1.64001e'),
    });
    const report = await runSegmentedExport(h.deps);
    expect(report.parameterSets).toBe('single');
    expect(h.sink[0]!.meta?.decoderConfig?.codec).toBe('avc1.64001e');
  });

  it('explains why a source is not copied', async () => {
    const small: CopySource = {
      ...sourceOf(30, 60),
      source: { config: { codec: 'avc1.64001e', codedWidth: 320, codedHeight: 180, description: SOURCE_DESC }, colorSpace: null },
    };
    const h = harness([clip('a', 2)], [], { source: small, cache: null });
    const report = await runSegmentedExport(h.deps);
    expect(report.framesCopied).toBe(0);
    expect(report.reasons.join('\n')).toMatch(/320x180, not the output 640x360/);
  });
});
