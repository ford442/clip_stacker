import { describe, expect, it } from 'vitest';
import type { Clip } from '../types';
import {
  PROXY_PROFILE,
  ProxyFrameSelector,
  clipProxyKey,
  makeClipProxy,
  planProxy,
  proxyBadgeFor,
  proxyDimensions,
  proxyStoreKey,
  resolvePreviewMedia,
} from './proxyMedia';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    file: new File([new Uint8Array([1, 2, 3])], 'cam.mp4'),
    objectUrl: 'blob:original',
    title: 'cam',
    kind: 'video',
    duration: 10,
    videoWidth: 3840,
    videoHeight: 2160,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

/** Frame timestamps (seconds) of `fps` footage over `seconds`. */
function timestamps(fps: number, seconds: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.round(fps * seconds); i++) out.push(Math.round((i / fps) * 1e6) / 1e6);
  return out;
}

function accepted(fps: number, seconds = 2): number {
  const selector = new ProxyFrameSelector(PROXY_PROFILE.maxFps);
  return timestamps(fps, seconds).filter((t) => selector.accept(t)).length;
}

describe('proxyDimensions', () => {
  it('scales the short side to 960 and keeps aspect with even dimensions', () => {
    expect(proxyDimensions(3840, 2160)).toEqual({ width: 1706, height: 960 });
    expect(proxyDimensions(1920, 1080)).toEqual({ width: 1706, height: 960 });
    // Portrait phone footage: the short side is the width.
    expect(proxyDimensions(2160, 3840)).toEqual({ width: 960, height: 1706 });
  });

  it('never upscales', () => {
    expect(proxyDimensions(640, 360)).toEqual({ width: 640, height: 360 });
  });
});

describe('planProxy', () => {
  it('plans a proxy for a >1080p video', () => {
    const plan = planProxy(makeClip());
    expect(plan).toMatchObject({ ok: true, width: 1706, height: 960 });
  });

  it('gives audio-only clips, stills and preview-sized sources no proxy', () => {
    expect(planProxy(makeClip({ kind: 'audio' })).ok).toBe(false);
    expect(planProxy(makeClip({ stillImage: true })).ok).toBe(false);
    expect(planProxy(makeClip({ videoWidth: 1280, videoHeight: 720 })).ok).toBe(false);
    expect(planProxy(makeClip({ videoWidth: undefined, videoHeight: undefined })).ok).toBe(false);
  });
});

describe('ProxyFrameSelector', () => {
  it('keeps every frame at or below the cap — never invents or drops', () => {
    expect(accepted(24)).toBe(48);
    expect(accepted(25)).toBe(50);
    expect(accepted(30)).toBe(60);
    expect(accepted(30000 / 1001)).toBe(timestamps(30000 / 1001, 2).length);
  });

  it('halves a 60 fps source to 30', () => {
    expect(accepted(60)).toBe(60);
  });

  it('caps 120 fps at 30', () => {
    expect(accepted(120)).toBe(60);
  });
});

describe('proxy keys', () => {
  it('keys by (sourceHash, profile)', () => {
    expect(proxyStoreKey('abc')).toBe(`proxy/${PROXY_PROFILE.id}/abc`);
    expect(proxyStoreKey('abc', 'other')).not.toBe(proxyStoreKey('abc'));
    const clip = makeClip({ proxy: makeClipProxy('abc', 1706, 960) });
    expect(clipProxyKey(clip)).toBe(proxyStoreKey('abc'));
    expect(clipProxyKey(makeClip())).toBeNull();
  });
});

describe('resolvePreviewMedia', () => {
  const proxyBlob = new Blob([new Uint8Array([9])], { type: 'video/mp4' });
  const clip = makeClip({ proxy: makeClipProxy('abc', 1706, 960) });
  const ready = { [proxyStoreKey('abc')]: { blob: proxyBlob, objectUrl: 'blob:proxy' } };

  it('reads the proxy when enabled and ready', () => {
    const media = resolvePreviewMedia(clip, { enabled: true, ready });
    expect(media).toEqual({ blob: proxyBlob, objectUrl: 'blob:proxy', source: 'proxy' });
  });

  it('reads the original when proxies are disabled', () => {
    const media = resolvePreviewMedia(clip, { enabled: false, ready });
    expect(media.blob).toBe(clip.file);
    expect(media.source).toBe('original');
  });

  it('reads the original while the proxy bytes are missing (e.g. after a reload)', () => {
    const media = resolvePreviewMedia(clip, { enabled: true, ready: {} });
    expect(media.blob).toBe(clip.file);
    expect(media.objectUrl).toBe('blob:original');
  });
});

describe('proxyBadgeFor', () => {
  it('reports building, proxy and original', () => {
    const clip = makeClip({ proxy: makeClipProxy('abc', 1706, 960) });
    const ready = { [proxyStoreKey('abc')]: { blob: new Blob(), objectUrl: '' } };
    expect(proxyBadgeFor(clip, { building: { c1: {} }, ready })).toBe('building');
    expect(proxyBadgeFor(clip, { building: {}, ready })).toBe('proxy');
    expect(proxyBadgeFor(clip, { building: {}, ready: {} })).toBe('original');
  });
});
