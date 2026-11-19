/**
 * Render-cache settings as export reads them (the cache itself is opened
 * lazily by `sharedRenderCache.ts`, so this stays out of the entry chunk).
 *
 * The settings are per-browser view state (`store/renderCacheStore.ts`
 * persists them and registers itself here), never part of a project: the
 * cache is this machine's disk, not the edit. Until the store registers, the
 * defaults apply. `?no_render_cache` turns both the cache and smart render
 * off for the page (resolved on main).
 */

export interface RenderCacheUsage {
  bytes: number;
  entries: number;
  budgetBytes: number;
  persistent: boolean;
  backend: 'opfs' | 'memory';
}

/** Default budget: 2 GiB. */
export const DEFAULT_RENDER_CACHE_BUDGET = 2 * 1024 ** 3;

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
/** The registered settings (no kill switch): what the shared cache sizes itself by. */
export function registeredRenderCacheConfig(): RenderCacheConfig {
  return source();
}

export function renderCacheConfig(): RenderCacheConfig {
  const config = source();
  return killSwitch() ? { ...config, enabled: false, smartRender: false } : config;
}

const usageListeners = new Set<(usage: RenderCacheUsage) => void>();

/** Report the shared cache's usage (`sharedRenderCache.ts`). */
export function emitRenderCacheUsage(usage: RenderCacheUsage): void {
  for (const listener of usageListeners) listener(usage);
}

/** Follow the shared cache's usage (fires once it opens, then on every change). */
export function onRenderCacheUsage(listener: (usage: RenderCacheUsage) => void): () => void {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}
