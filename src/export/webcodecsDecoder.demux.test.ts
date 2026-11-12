import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { ClipFrameDecoder, getLastDecoderAcceleration } from './webcodecsDecoder';
import { DecoderFrameCursor } from '../media/decoderCursor';
import { DecoderCursorPool, cursorStartAt } from '../media/decoderCursorPool';
import { TimelineDecoderFrameProvider } from '../media/decoderFrameProvider';
import { PreviewDecoderSource } from '../webgpu/previewDecoderSource';
import type { Clip } from '../types';
import type { PreviewClipLayer } from '../composition/previewComposition';
import type { WorkerClip } from '../webgpu/previewWorkerProtocol';
import {
  buildTestMp4,
  buildTestWebm,
  collectFrameTimes,
  FakeVideoFrame,
  installFakeWebCodecs,
  ReadLoggingBlob,
} from './container/demux.test.helpers';
import { colorSpaceForOverride } from '../media/sourceColorSpace';

// Mediabunny sniffs the browser once per module instance; read the way it
// does in Chromium (a lazily pulled `blob.slice(pos).stream()` per reader).
beforeAll(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeVideoFrame.open = 0;
});

/** Each test gets its own coded size, so the per-shape rung cache never leaks between tests. */
let nextWidth = 1000;
function uniqueWidth(): number {
  return (nextWidth += 16);
}

function videoClip(file: Blob, over: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    file: file as File,
    objectUrl: 'blob:clip-1',
    title: 'Clip 1',
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: 10,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...over,
  } as Clip;
}

function layer(sourceTime: number): PreviewClipLayer {
  return {
    kind: 'base',
    clipId: 'clip-1',
    timelineIndex: 0,
    zIndex: 0,
    localElapsed: sourceTime,
    clipDuration: 10,
    sourceTime,
    opacity: 1,
    rect: { x: 0, y: 0, width: 1280, height: 720 },
    crossfade: null,
    uvScale: [1, 1],
    uvOffset: [0, 0],
  } as PreviewClipLayer;
}

describe('ClipFrameDecoder over the demux facade', () => {
  it('decodes the trim window from the key frame before it, and stops feeding at its end', async () => {
    const fake = installFakeWebCodecs();
    const blob = new Blob([await buildTestMp4({ width: uniqueWidth(), height: 360, seconds: 6 })]);

    const decoder = await ClipFrameDecoder.open(blob, { trimStart: 2.5, trimEnd: 4 });
    const times = await collectFrameTimes(decoder.frames());
    decoder.close();

    expect(times).toHaveLength(45); // 2.5 s … 3.967 s at 30 fps
    expect(times[0]).toBeCloseTo(2.5, 6);
    expect(times.at(-1)).toBeCloseTo(4 - 1 / 30, 3);
    expect(Math.min(...fake.decoded)).toBe(2_000_000); // the key frame at 2 s
    // Not fed to the end of the file: a decoded frame at trimEnd stops it.
    expect(Math.max(...fake.decoded)).toBeLessThan(4_100_000);
    expect(FakeVideoFrame.open).toBe(0);
  });

  it('startAt hands out the same frames as decoding all the way from trimStart', async () => {
    installFakeWebCodecs();
    const blob = new Blob([await buildTestMp4({ width: uniqueWidth(), height: 360, seconds: 6 })]);
    const trimStart = 1.01; // between frames: the frame at 1.0 s is outside the window

    for (const t of [1.02, 2.0, 2.01, 3.5 + 1 / 60, 5.99]) {
      const fromStart = await DecoderFrameCursor.open(blob, trimStart, 6);
      const atTarget = await DecoderFrameCursor.open(blob, trimStart, 6, { startAt: t });
      const expected = await fromStart.frameAt(t);
      const actual = await atTarget.frameAt(t);
      expect(actual!.timestamp).toBe(expected!.timestamp);
      expected!.close();
      actual!.close();
      // And they keep agreeing going forward.
      const [a, b] = [await fromStart.frameAt(t + 0.1), await atTarget.frameAt(t + 0.1)];
      expect(b?.timestamp).toBe(a?.timestamp);
      a?.close();
      b?.close();
      fromStart.close();
      atTarget.close();
    }
    expect(FakeVideoFrame.open).toBe(0);
  });

  it('a backward reopen on a large file reads the index once and only the GOP it needs', async () => {
    const fake = installFakeWebCodecs();
    // 10 s of 24 KB packets, 1 s GOPs (~7 MB), padded to a 2 GiB "camera file".
    const bytes = await buildTestMp4({ width: uniqueWidth(), height: 1080, seconds: 10, packetBytes: 24 * 1024 });
    const blob = new ReadLoggingBlob(bytes, 2 * 2 ** 30);
    const pool = new DecoderCursorPool((_key, sourceTime) =>
      DecoderFrameCursor.open(blob, 0, 10, {
        optimizeForLatency: true,
        ...(cursorStartAt(sourceTime, 0, 10) !== undefined ? { startAt: sourceTime } : {}),
      }),
    );

    const readsPerRequest: number[] = [];
    // A scrub dragged backward: each jump of more than a frame reopens the
    // cursor (small forward steps continue it), including repeat visits.
    for (const t of [9, 9.5, 6.4, 6.5, 6.4, 2.2, 1.1, 0.5]) {
      blob.log.reset();
      fake.decoded.length = 0;
      const frame = await pool.frameAt('clip', t);
      expect(frame).not.toBeNull();
      expect(frame!.timestamp / 1_000_000).toBeCloseTo(Math.floor(t * 30) / 30, 5);
      frame!.close();
      readsPerRequest.push(blob.log.bytesRead);
      // Nothing decoded before the key frame preceding t: a reopen starts
      // there, not at 0, and a forward request continues the cursor.
      expect(Math.min(...fake.decoded)).toBeGreaterThanOrEqual(Math.floor(t) * 1_000_000);
    }
    pool.destroy();

    expect(blob.log.wholeReads).toEqual([]);
    expect(blob.log.largestRead).toBeLessThanOrEqual(64 * 1024); // stream chunks, pulled lazily
    // One GOP is 720 KB; a request reads at most that plus Mediabunny's read-ahead.
    expect(Math.max(...readsPerRequest)).toBeLessThan(2 * 2 ** 20);
    expect(readsPerRequest.reduce((a, b) => a + b, 0)).toBeLessThan(bytes.byteLength);
    expect(FakeVideoFrame.open).toBe(0);
  });

  it('probes the acceleration ladder once per codec + coded size', async () => {
    const fake = installFakeWebCodecs((config) => config.hardwareAcceleration === 'prefer-software');
    const width = uniqueWidth();
    const a = new Blob([await buildTestMp4({ width, height: 720, seconds: 1 })]);
    const b = new Blob([await buildTestMp4({ width, height: 720, seconds: 1 })]);

    (await ClipFrameDecoder.open(a, { trimStart: 0, trimEnd: 1 })).close();
    expect(fake.isConfigSupported).toHaveBeenCalledTimes(3);
    expect(getLastDecoderAcceleration()).toBe('prefer-software');

    // Another file of the same shape, and a reopen: no probes, same rung.
    (await ClipFrameDecoder.open(b, { trimStart: 0, trimEnd: 1 })).close();
    (await ClipFrameDecoder.open(a, { trimStart: 0.5, trimEnd: 1 })).close();
    expect(fake.isConfigSupported).toHaveBeenCalledTimes(3);
    expect(fake.configs.map((c) => c.hardwareAcceleration)).toEqual([
      'prefer-software',
      'prefer-software',
      'prefer-software',
    ]);
    // Each file still configures with its own description.
    expect(fake.configs[0]!.description).not.toBe(fake.configs[1]!.description);

    // A new coded size probes again.
    const c = new Blob([await buildTestMp4({ width: uniqueWidth(), height: 720, seconds: 1 })]);
    (await ClipFrameDecoder.open(c, { trimStart: 0, trimEnd: 1 })).close();
    expect(fake.isConfigSupported).toHaveBeenCalledTimes(6);
  });

  it('does not remember a ladder that found no rung', async () => {
    let supported = false;
    const fake = installFakeWebCodecs(() => supported);
    const blob = new Blob([await buildTestMp4({ width: uniqueWidth(), height: 720, seconds: 1 })]);

    await expect(ClipFrameDecoder.open(blob, { trimStart: 0, trimEnd: 1 })).rejects.toThrow(/does not support/);
    supported = true;
    (await ClipFrameDecoder.open(blob, { trimStart: 0, trimEnd: 1 })).close();
    expect(fake.isConfigSupported).toHaveBeenCalledTimes(4);
  });

  it('tags the decoder config with the container colour space; untagged files carry none', async () => {
    const fake = installFakeWebCodecs();
    const hlg: VideoColorSpaceInit = {
      primaries: 'bt2020' as VideoColorPrimaries,
      transfer: 'hlg' as VideoTransferCharacteristics,
      matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
      fullRange: false,
    };
    const tagged = new Blob([await buildTestMp4({ width: uniqueWidth(), height: 720, seconds: 1, colorSpace: hlg })]);
    const untagged = new Blob([await buildTestMp4({ width: uniqueWidth(), height: 720, seconds: 1 })]);

    const decoder = await ClipFrameDecoder.open(tagged, { trimStart: 0, trimEnd: 1 });
    const [first] = await (async () => {
      for await (const frame of decoder.frames()) return [frame];
      return [];
    })();
    expect(first!.colorSpace).toEqual(hlg); // the fake decoder tags frames from the config
    first!.close();
    decoder.close();
    (await ClipFrameDecoder.open(untagged, { trimStart: 0, trimEnd: 1 })).close();

    expect(fake.configs[0]!.colorSpace).toEqual(hlg);
    expect('colorSpace' in fake.configs[1]!).toBe(false);
  });

  it('decodes as Clip.colorSpaceOverride instead of the file tags, in preview and export', async () => {
    const fake = installFakeWebCodecs();
    const width = uniqueWidth();
    const blob = new Blob([await buildTestMp4({ width, height: 360, seconds: 2 })]);
    const pq = colorSpaceForOverride('rec2020-pq');

    const preview = new PreviewDecoderSource();
    preview.setClipMedia('clip-1', blob);
    const workerClip = videoClip(blob, { duration: 2, trimEnd: 2, colorSpaceOverride: 'rec2020-pq' });
    const split = await preview.split(
      [{ clipId: 'clip-1', role: 'base', sourceTime: 0.5 }],
      new Map([['clip-1', workerClip as unknown as WorkerClip]]),
    );
    split.decoded.forEach((captured) => captured.frame.close());
    preview.destroy();

    const exporter = new TimelineDecoderFrameProvider();
    (await exporter.getFrame(layer(0.5), videoClip(blob, { duration: 2, trimEnd: 2, colorSpaceOverride: 'rec2020-pq' })))?.close();
    // The override changed: a new cursor, decoding the file as tagged (untagged here).
    (await exporter.getFrame(layer(0.6), videoClip(blob, { duration: 2, trimEnd: 2 })))?.close();
    exporter.destroy();

    expect(fake.configs).toHaveLength(3);
    expect(fake.configs[0]!.colorSpace).toEqual(pq);
    expect(fake.configs[1]!.colorSpace).toEqual(pq);
    expect('colorSpace' in fake.configs[2]!).toBe(false);
  });

  it('refuses an empty trim window up front', async () => {
    installFakeWebCodecs();
    const blob = new Blob([await buildTestMp4({ width: uniqueWidth(), height: 720, seconds: 1 })]);
    await expect(ClipFrameDecoder.open(blob, { trimStart: 1, trimEnd: 1 })).rejects.toThrow(/no video samples/);
  });
});

describe('optimizeForLatency', () => {
  it('is set for preview cursors and never for export, proxy or stabilization opens', async () => {
    const fake = installFakeWebCodecs();
    const width = uniqueWidth();
    const blob = new Blob([await buildTestMp4({ width, height: 360, seconds: 4 })]);

    // Preview worker: the default cursor factory, a forward request then a backward scrub.
    const preview = new PreviewDecoderSource();
    preview.setClipMedia('clip-1', blob);
    const clips = new Map([['clip-1', videoClip(blob, { duration: 4, trimEnd: 4 }) as unknown as WorkerClip]]);
    for (const sourceTime of [3, 1]) {
      const split = await preview.split([{ clipId: 'clip-1', role: 'base', sourceTime }], clips);
      expect(split.fallback).toEqual([]);
      split.decoded.forEach((captured) => captured.frame.close());
    }
    preview.destroy();
    const previewConfigs = fake.configs.splice(0);
    expect(previewConfigs).toHaveLength(2);
    expect(previewConfigs.every((c) => c.optimizeForLatency === true)).toBe(true);

    // GPU export cursors.
    const exporter = new TimelineDecoderFrameProvider();
    const clip = videoClip(blob, { duration: 4, trimEnd: 4 });
    for (const sourceTime of [3, 1]) (await exporter.getFrame(layer(sourceTime), clip))?.close();
    exporter.destroy();
    // Proxies, stabilization and the per-clip export encode open the decoder directly.
    (await ClipFrameDecoder.open(blob, { trimStart: 0, trimEnd: 4 })).close();

    expect(fake.configs).toHaveLength(3);
    expect(fake.configs.some((c) => 'optimizeForLatency' in c)).toBe(false);
  });
});

describe('WebM', () => {
  it('decodes VP8 WebM on the decoder path', async () => {
    const fake = installFakeWebCodecs();
    const blob = new Blob([await buildTestWebm({ width: 320, height: 240, frames: 30, gop: 10 })]);

    const decoder = await ClipFrameDecoder.open(blob, { trimStart: 0.4, trimEnd: 1 });
    const times = await collectFrameTimes(decoder.frames());
    decoder.close();

    expect(fake.configs[0]!.codec).toBe('vp8');
    expect(times[0]).toBeCloseTo(0.4, 2);
    expect(times).toHaveLength(18);
    expect(Math.min(...fake.decoded)).toBe(333_000); // the key frame at frame 10
  });

  it('decodes WebM with alpha through Mediabunny: alpha decoded and merged, software rung first', async () => {
    const fake = installFakeWebCodecs();
    const blob = new Blob([await buildTestWebm({ width: 64, height: 64, frames: 30, gop: 10, alpha: true })]);

    const decoder = await ClipFrameDecoder.open(blob, { trimStart: 0.5, trimEnd: 0.9, optimizeForLatency: true });
    const frames: FakeVideoFrame[] = [];
    for await (const frame of decoder.frames()) frames.push(frame as unknown as FakeVideoFrame);
    decoder.close();

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.alphaMerged)).toBe(true);
    expect(frames[0]!.timestamp / 1_000_000).toBeCloseTo(0.5, 2);
    expect(frames.at(-1)!.timestamp / 1_000_000).toBeLessThan(0.9);
    expect(fake.merges).toBeGreaterThanOrEqual(frames.length);
    // Color and alpha decoders, both on the software rung, latency-optimized for preview.
    expect(fake.configs.length).toBeGreaterThanOrEqual(2);
    expect(fake.configs.every((c) => c.hardwareAcceleration === 'prefer-software')).toBe(true);
    expect(fake.configs.every((c) => c.optimizeForLatency === true)).toBe(true);
    expect(getLastDecoderAcceleration()).toBe('prefer-software');

    frames.forEach((f) => f.close());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeVideoFrame.open).toBe(0);
  });

  it('serves WebM alpha layers from the preview decoder — nothing falls back to <video>', async () => {
    installFakeWebCodecs();
    const blob = new Blob([await buildTestWebm({ width: 64, height: 64, frames: 30, alpha: true })]);
    const preview = new PreviewDecoderSource();
    preview.setClipMedia('clip-1', blob);
    const clips = new Map([['clip-1', videoClip(blob, { duration: 1, trimEnd: 1 }) as unknown as WorkerClip]]);

    for (const sourceTime of [0.2, 0.6, 0.1]) {
      const split = await preview.split([{ clipId: 'clip-1', role: 'base', sourceTime }], clips);
      expect(split.fallback).toEqual([]);
      expect(split.decoded).toHaveLength(1);
      expect((split.decoded[0]!.frame as unknown as FakeVideoFrame).alphaMerged).toBe(true);
      split.decoded[0]!.frame.close();
    }
    preview.destroy();
  });
});
