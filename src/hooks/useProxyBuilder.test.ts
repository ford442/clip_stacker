import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '../types';
import { buildClipProxy, ProxyReconciler, type ProxyBuildDeps } from './useProxyBuilder';
import { createMemoryMediaStore } from '../utils/mediaStore';
import { makeClipProxy, proxyStoreKey } from '../utils/proxyMedia';
import { ProxyBuildCancelled } from '../utils/proxyEncoder';
import { proxyStore } from '../store/proxyStore';

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

function deps(over: Partial<ProxyBuildDeps> = {}): ProxyBuildDeps {
  return {
    store: createMemoryMediaStore(),
    fingerprint: vi.fn(async () => 'feedface'),
    encode: vi.fn(async () => new Blob([new Uint8Array([9])], { type: 'video/mp4' })),
    ...over,
  };
}

beforeEach(() => {
  proxyStore.setState({ enabled: true, queue: [], building: {}, errors: {}, ready: {} });
});

describe('buildClipProxy', () => {
  it('encodes at the planned size and stores under (hash, profile)', async () => {
    const d = deps();
    const result = await buildClipProxy(makeClip(), {}, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key).toBe(proxyStoreKey('feedface'));
    expect(result.proxy).toEqual(makeClipProxy('feedface', 1706, 960));
    expect(d.encode).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ width: 1706, height: 960, durationSec: 10 }),
    );
    expect(await d.store.get(result.key)).toBe(result.blob);
  });

  it('reuses stored bytes for the same source instead of re-encoding', async () => {
    const d = deps();
    const existing = new Blob([new Uint8Array([4])]);
    await d.store.put(proxyStoreKey('feedface'), existing);
    const result = await buildClipProxy(makeClip(), {}, d);
    expect(result.ok && result.blob).toBe(existing);
    expect(d.encode).not.toHaveBeenCalled();
  });

  it('refuses audio-only clips without touching the encoder', async () => {
    const d = deps();
    const result = await buildClipProxy(makeClip({ kind: 'audio' }), {}, d);
    expect(result.ok).toBe(false);
    expect(d.encode).not.toHaveBeenCalled();
  });

  it('reports encode failures and cancellation without throwing', async () => {
    const failing = deps({ encode: vi.fn(async () => Promise.reject(new Error('no H.264 encoder'))) });
    expect(await buildClipProxy(makeClip(), {}, failing)).toEqual({ ok: false, reason: 'no H.264 encoder' });

    const cancelled = deps({ encode: vi.fn(async () => Promise.reject(new ProxyBuildCancelled())) });
    const result = await buildClipProxy(makeClip(), {}, cancelled);
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(await cancelled.store.has(proxyStoreKey('feedface'))).toBe(false);
  });
});

describe('ProxyReconciler', () => {
  const key = proxyStoreKey('feedface');
  const proxied = makeClip({ proxy: makeClipProxy('feedface', 1706, 960) });

  it('loads a referenced proxy from the store', async () => {
    const store = createMemoryMediaStore();
    const blob = new Blob([new Uint8Array([9])]);
    await store.put(key, blob);
    await new ProxyReconciler({ store }).reconcile([proxied]);
    expect(proxyStore.getState().ready[key]?.blob).toBe(blob);
  });

  it('leaves a clip on its original when the store has no bytes (in-memory store after reload)', async () => {
    await new ProxyReconciler({ store: createMemoryMediaStore() }).reconcile([proxied]);
    expect(proxyStore.getState().ready[key]).toBeUndefined();
  });

  it('deletes the proxy when its last clip is removed, and an undo writes it back', async () => {
    const store = createMemoryMediaStore();
    const blob = new Blob([new Uint8Array([9])]);
    await store.put(key, blob);
    const reconciler = new ProxyReconciler({ store });
    await reconciler.reconcile([proxied]);

    // Remove the clip.
    await reconciler.reconcile([]);
    expect(proxyStore.getState().ready[key]).toBeUndefined();
    expect(await store.has(key)).toBe(false);

    // Undo brings the clip back while the blob is still in memory.
    await reconciler.reconcile([proxied]);
    expect(proxyStore.getState().ready[key]?.blob).toBe(blob);
    expect(await store.get(key)).toBe(blob);
  });

  it('keeps a proxy shared by a split while one of its clips remains', async () => {
    const store = createMemoryMediaStore();
    await store.put(key, new Blob([new Uint8Array([9])]));
    const reconciler = new ProxyReconciler({ store });
    const other = { ...proxied, id: 'c2' };
    await reconciler.reconcile([proxied, other]);
    await reconciler.reconcile([other]);
    expect(proxyStore.getState().ready[key]).toBeDefined();
    expect(await store.has(key)).toBe(true);
  });
});
