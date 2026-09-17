import { describe, expect, it, vi } from 'vitest';
import { PreviewDecoderSource, decoderLayerKey } from './previewDecoderSource';
import type { FrameRequest, WorkerClip } from './previewWorkerProtocol';
import type { ForwardFrameCursor } from '../utils/decoderCursorPool';

function videoClip(id: string, over: Partial<WorkerClip> = {}): WorkerClip {
  return {
    id,
    kind: 'video',
    duration: 10,
    trimStart: 0,
    trimEnd: 10,
    ...over,
  } as unknown as WorkerClip;
}

function frame(): VideoFrame {
  return {
    timestamp: 0,
    displayWidth: 1920,
    displayHeight: 1080,
    codedWidth: 1920,
    codedHeight: 1080,
    close: vi.fn(),
  } as unknown as VideoFrame;
}

function cursorFactory(impl?: () => ForwardFrameCursor) {
  return vi.fn(async () => impl?.() ?? { frameAt: vi.fn(async () => frame()), close: vi.fn() });
}

function request(clipId: string, over: Partial<FrameRequest> = {}): FrameRequest {
  return { clipId, role: 'base', sourceTime: 0, ...over };
}

describe('PreviewDecoderSource', () => {
  it('serves a registered video clip from the decoder — nothing goes back to main', async () => {
    const factory = cursorFactory();
    const source = new PreviewDecoderSource(factory);
    source.setClipMedia('a', new Blob([new Uint8Array([1])]));

    const split = await source.split([request('a')], new Map([['a', videoClip('a')]]));

    expect(split.fallback).toEqual([]);
    expect(split.decoded).toHaveLength(1);
    expect(split.decoded[0]!.videoWidth).toBe(1920);
    expect(factory).toHaveBeenCalledWith(expect.any(Blob), 0, 10);
  });

  it('passes the clip trim window to the cursor, resolving NaN trimEnd to duration', async () => {
    const factory = cursorFactory();
    const source = new PreviewDecoderSource(factory);
    source.setClipMedia('a', new Blob());

    await source.split(
      [request('a', { sourceTime: 2 })],
      new Map([['a', videoClip('a', { trimStart: 1, trimEnd: NaN, duration: 8 })]]),
    );

    expect(factory).toHaveBeenCalledWith(expect.any(Blob), 1, 8);
  });

  it('falls back for stills, non-video clips, morph segments, and unregistered media', async () => {
    const source = new PreviewDecoderSource(cursorFactory());
    source.setClipMedia('still', new Blob());
    source.setClipMedia('audio', new Blob());
    source.setClipMedia('morph', new Blob());

    const clips = new Map<string, WorkerClip>([
      ['still', videoClip('still', { stillImage: true })],
      ['audio', videoClip('audio', { kind: 'audio' } as Partial<WorkerClip>)],
      ['morph', videoClip('morph')],
      ['unregistered', videoClip('unregistered')],
    ]);

    const split = await source.split(
      [
        request('still'),
        request('audio'),
        request('morph', { mediaObjectUrl: 'blob:morph' }),
        request('unregistered'),
      ],
      clips,
    );

    expect(split.decoded).toEqual([]);
    expect(split.fallback.map((r) => r.clipId)).toEqual([
      'still',
      'audio',
      'morph',
      'unregistered',
    ]);
  });

  it('falls back (once) for media the decoder cannot open, e.g. WebM+alpha', async () => {
    const factory = vi.fn(async () => {
      throw new Error('MP4 demux failed');
    });
    const source = new PreviewDecoderSource(factory);
    source.setClipMedia('webm', new Blob());
    const clips = new Map([['webm', videoClip('webm')]]);

    const first = await source.split([request('webm')], clips);
    const second = await source.split([request('webm', { sourceTime: 1 })], clips);

    expect(first.fallback).toHaveLength(1);
    expect(second.fallback).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reopens the cursor on a backward scrub instead of stalling', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const factory = vi.fn(async () => {
      const close = vi.fn();
      closes.push(close);
      return { frameAt: vi.fn(async () => frame()), close };
    });
    const source = new PreviewDecoderSource(factory);
    source.setClipMedia('a', new Blob());
    const clips = new Map([['a', videoClip('a')]]);

    await source.split([request('a', { sourceTime: 5 })], clips);
    await source.split([request('a', { sourceTime: 0.5 })], clips);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(closes[0]).toHaveBeenCalled();
  });

  it('gives each crossfade role its own cursor', async () => {
    const factory = cursorFactory();
    const source = new PreviewDecoderSource(factory);
    source.setClipMedia('a', new Blob());

    await source.split(
      [request('a', { role: 'outgoing' }), request('a', { role: 'incoming' })],
      new Map([['a', videoClip('a')]]),
    );

    expect(factory).toHaveBeenCalledTimes(2);
    expect(decoderLayerKey(request('a', { role: 'outgoing' }))).not.toBe(
      decoderLayerKey(request('a', { role: 'incoming' })),
    );
  });

  it('drops media and cursors for clips that left the timeline', async () => {
    const source = new PreviewDecoderSource(cursorFactory());
    source.setClipMedia('a', new Blob());
    source.setClipMedia('b', new Blob());
    await source.split([request('a'), request('b')], new Map([
      ['a', videoClip('a')],
      ['b', videoClip('b')],
    ]));
    expect(source.activeCount).toBe(2);

    source.pruneExcept(new Set(['a']));

    expect(source.activeCount).toBe(1);
    expect(source.hasClipMedia('b')).toBe(false);
  });

  it('releases cursors on pause but keeps the registered media', async () => {
    const source = new PreviewDecoderSource(cursorFactory());
    source.setClipMedia('a', new Blob());
    await source.split([request('a')], new Map([['a', videoClip('a')]]));

    source.releaseCursors();

    expect(source.activeCount).toBe(0);
    expect(source.hasClipMedia('a')).toBe(true);
  });
});
