/**
 * The process-wide render cache: OPFS when this browser has writable OPFS
 * files, else memory (it then lasts until the tab closes). Opened on first
 * use; usage changes are reported through `renderCacheConfig.ts`.
 */

import { createMemoryCacheBackend, openOpfsCacheBackend } from './cacheBackend';
import { RenderCache } from './renderCache';
import { emitRenderCacheUsage, registeredRenderCacheConfig } from './renderCacheConfig';

let shared: Promise<RenderCache> | null = null;

export function sharedRenderCache(): Promise<RenderCache> {
  shared ??= (async () => {
    const backend = (await openOpfsCacheBackend()) ?? createMemoryCacheBackend();
    const cache = new RenderCache(backend, { budgetBytes: registeredRenderCacheConfig().budgetBytes });
    cache.onChange(emitRenderCacheUsage);
    await cache.ready();
    emitRenderCacheUsage(cache.usage());
    return cache;
  })();
  return shared;
}
