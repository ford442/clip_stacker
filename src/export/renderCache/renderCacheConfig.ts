/**
 * Render-cache settings as export reads them, and the process-wide cache.
 *
 * The settings are per-browser view state (`store/renderCacheStore.ts`
 * persists them and registers itself here), never part of a project: the
 * cache is this machine's disk, not the edit. Until the store registers, the
 * defaults apply. `?no_render_cache` turns both the cache and smart render
 * off for the page (resolved on main).
 */

import { openOpfsCacheBackend, createMemoryCacheBackend } from './cacheBackend';
import { DEFAULT_RENDER_CACHE_BUDGET, RenderCache, type RenderCacheUsage } from './renderCache';

export interface RenderCacheConfig {
  /** Reuse cached segments and store newly rendered ones. */
  enabled: boolean;
  /** Copy untouched source GOPs instead of re-encoding them. */
  smartRender: boolean;
  /** LRU budget in bytes. */
  budgetBytes: number;
}

export const DEFAULT_RENDER_CACHE_CONFIG: RenderCacheConfig = {
  enabled: true,
  smartRender: true,
  budgetBytes: DEFAULT_RENDER_CACHE_BUDGET,
};

let source: () => RenderCacheConfig = () => DEFAULT_RENDER_CACHE_CONFIG;

export function registerRenderCacheConfigSource(next: () => RenderCacheConfig): void {
  source = next;
}

function killSwitch(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('no_render_cache');
  } catch {
    return false;
  }
}

/** The settings this export runs with (the kill switch applied). */
export function renderCacheConfig(): RenderCacheConfig {
  const config = source();
  return killSwitch() ? { ...config, enabled: false, smartRender: false } : config;
}

let shared: Promise<RenderCache> | null = null;
const usageListeners = new Set<(usage: RenderCacheUsage) => void>();

/**
 * The process-wide cache: OPFS when this browser has writable OPFS files,
 * else memory (it then lasts until the tab closes). Opened on first use.
 */
export function sharedRenderCache(): Promise<RenderCache> {
  shared ??= (async () => {
    const backend = (await openOpfsCacheBackend()) ?? createMemoryCacheBackend();
    const cache = new RenderCache(backend, { budgetBytes: source().budgetBytes });
    cache.onChange((usage) => {
      for (const listener of usageListeners) listener(usage);
    });
    await cache.ready();
    for (const listener of usageListeners) listener(cache.usage());
    return cache;
  })();
  return shared;
}

/** Follow the shared cache's usage (fires once it opens, then on every change). */
export function onRenderCacheUsage(listener: (usage: RenderCacheUsage) => void): () => void {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}
