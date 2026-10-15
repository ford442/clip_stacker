import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Clip } from '../types';
import { proxyActions, proxyStore, useProxyState } from '../store/proxyStore';
import { fingerprintMedia, getMediaStore, type MediaStore } from '../utils/mediaStore';
import {
  clipProxyKey,
  makeClipProxy,
  planProxy,
  proxyStoreKey,
} from '../utils/proxyMedia';
import type { EncodeProxyOptions } from '../utils/proxyEncoder';

export interface ProxyBuildDeps {
  store: MediaStore;
  fingerprint: (blob: Blob) => Promise<string>;
  encode: (source: Blob, options: EncodeProxyOptions) => Promise<Blob>;
}

const defaultDeps = (): ProxyBuildDeps => ({
  store: getMediaStore(),
  fingerprint: fingerprintMedia,
  // The encoder (decoder, mp4box, muxer) loads with the first proxy build.
  encode: async (source, options) =>
    (await import('../utils/proxyEncoder')).encodeProxy(source, options),
});

/**
 * Matched by name so classifying an error does not need the encoder module
 * (and with it the encoder) loaded.
 */
function isProxyBuildCancelled(err: unknown): boolean {
  return (err as Error | null)?.name === 'ProxyBuildCancelled';
}

export type ProxyBuildResult =
  | { ok: true; key: string; blob: Blob; proxy: NonNullable<Clip['proxy']> }
  | { ok: false; reason: string; cancelled?: boolean };

/**
 * Build (or reuse) the proxy for one clip and put it in the media store.
 * Never throws: every failure comes back as `{ ok: false, reason }`.
 */
export async function buildClipProxy(
  clip: Clip,
  options: { signal?: AbortSignal; onProgress?: (p: number) => void } = {},
  deps: ProxyBuildDeps = defaultDeps(),
): Promise<ProxyBuildResult> {
  const plan = planProxy(clip);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  try {
    const hash = await deps.fingerprint(clip.file);
    const key = proxyStoreKey(hash, plan.profile.id);
    const proxy = makeClipProxy(hash, plan.width, plan.height, plan.profile);
    // Same source bytes already proxied (a split, a re-import): reuse them.
    const existing = await deps.store.get(key);
    if (existing) return { ok: true, key, blob: existing, proxy };

    const blob = await deps.encode(clip.file, {
      width: plan.width,
      height: plan.height,
      durationSec: clip.duration,
      profile: plan.profile,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    if (options.signal?.aborted) return { ok: false, reason: 'cancelled', cancelled: true };
    await deps.store.put(key, blob);
    return { ok: true, key, blob, proxy };
  } catch (err) {
    if (isProxyBuildCancelled(err) || options.signal?.aborted) {
      return { ok: false, reason: 'cancelled', cancelled: true };
    }
    return { ok: false, reason: (err as Error)?.message || String(err) };
  }
}

/** Evicted proxies kept in memory so an undo can write them back (#279's rule). */
const RECENTLY_EVICTED_LIMIT = 4;

export class ProxyReconciler {
  private readonly recentlyEvicted = new Map<string, Blob>();
  private readonly resolving = new Set<string>();

  constructor(private readonly deps: Pick<ProxyBuildDeps, 'store'> = { store: getMediaStore() }) {}

  /**
   * Bring the ready set in line with the clip pool: a key no clip references
   * any more is evicted and deleted from the store (kept briefly in memory);
   * a referenced key not yet ready is loaded from the store, or written back
   * from memory when an undo restored its clip.
   */
  async reconcile(clips: Clip[]): Promise<void> {
    const referenced = new Map<string, NonNullable<Clip['proxy']>>();
    for (const clip of clips) {
      const key = clipProxyKey(clip);
      if (key && clip.proxy) referenced.set(key, clip.proxy);
    }

    const deletions: Promise<void>[] = [];
    for (const key of Object.keys(proxyStore.getState().ready)) {
      if (referenced.has(key)) continue;
      const blob = proxyActions.evict(key);
      if (blob) this.remember(key, blob);
      deletions.push(this.deps.store.delete(key).catch(() => undefined));
    }

    const loads: Promise<void>[] = [];
    for (const [key, proxy] of referenced) {
      if (proxyStore.getState().ready[key] || this.resolving.has(key)) continue;
      this.resolving.add(key);
      loads.push(
        this.load(key)
          .then((blob) => {
            if (blob) proxyActions.setReady(key, blob, proxy.width, proxy.height);
          })
          .finally(() => this.resolving.delete(key)),
      );
    }
    await Promise.all([...deletions, ...loads]);
  }

  private remember(key: string, blob: Blob): void {
    this.recentlyEvicted.delete(key);
    this.recentlyEvicted.set(key, blob);
    while (this.recentlyEvicted.size > RECENTLY_EVICTED_LIMIT) {
      const oldest = this.recentlyEvicted.keys().next().value as string;
      this.recentlyEvicted.delete(oldest);
    }
  }

  private async load(key: string): Promise<Blob | null> {
    const stored = await this.deps.store.get(key).catch(() => null);
    if (stored) return stored;
    const held = this.recentlyEvicted.get(key);
    if (!held) return null;
    this.recentlyEvicted.delete(key);
    await this.deps.store.put(key, held).catch(() => undefined);
    return held;
  }
}

/**
 * Runs the proxy queue (one clip at a time, in the background) and keeps the
 * ready set in step with the clip pool. A build is cancelled when its clip
 * leaves the project; removing the last clip that references a proxy deletes
 * it from the media store.
 */
export function useProxyBuilder(
  clips: Clip[],
  setClips: Dispatch<SetStateAction<Clip[]>>,
): void {
  const queue = useProxyState((s) => s.queue);
  const [finished, setFinished] = useState(0);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const inFlight = useRef<{ clipId: string; controller: AbortController } | null>(null);
  const reconciler = useRef<ProxyReconciler | null>(null);
  reconciler.current ??= new ProxyReconciler();

  useEffect(() => {
    void reconciler.current!.reconcile(clips);
    const ids = new Set(clips.map((c) => c.id));
    const running = inFlight.current;
    if (running && !ids.has(running.clipId)) running.controller.abort();
    for (const id of proxyStore.getState().queue) {
      if (!ids.has(id)) proxyActions.forgetClip(id);
    }
  }, [clips]);

  useEffect(() => {
    if (inFlight.current || queue.length === 0) return;
    const clipId = queue[0]!;
    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip) {
      proxyActions.forgetClip(clipId);
      return;
    }

    const controller = new AbortController();
    inFlight.current = { clipId, controller };
    proxyActions.startBuild(clipId);

    void buildClipProxy(clip, {
      signal: controller.signal,
      onProgress: (p) => proxyActions.setBuildProgress(clipId, p),
    })
      .then((result) => {
        if (!result.ok) {
          if (result.cancelled) proxyActions.forgetClip(clipId);
          else proxyActions.finishBuild(clipId, result.reason);
          return;
        }
        // Stamp every clip over the same source (splits share one file and
        // one proxy), then publish the bytes.
        setClips((prev) =>
          prev.map((c) =>
            c.file === clip.file && c.proxy?.hash !== result.proxy.hash
              ? { ...c, proxy: result.proxy }
              : c,
          ),
        );
        proxyActions.setReady(result.key, result.blob, result.proxy.width, result.proxy.height);
        proxyActions.finishBuild(clipId);
      })
      .finally(() => {
        inFlight.current = null;
        setFinished((n) => n + 1);
      });
  }, [queue, finished, setClips]);

  useEffect(
    () => () => {
      inFlight.current?.controller.abort();
    },
    [],
  );
}

/** Whether "Build proxy" should be offered for a clip. */
export function canBuildProxy(clip: Clip): boolean {
  return planProxy(clip).ok;
}

