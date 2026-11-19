import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { safeGet, safeSet } from '../utils/storageKeys';
import {
  DEFAULT_RENDER_CACHE_CONFIG,
  onRenderCacheUsage,
  registerRenderCacheConfigSource,
  sharedRenderCache,
} from '../export/renderCache/renderCacheConfig';
import type { RenderCacheUsage } from '../export/renderCache/renderCache';

/**
 * Render cache, smart render and preview cache settings, per browser
 * (`clip_stacker.renderCache.v1`): they describe this machine's disk and GPU,
 * not the edit, so they are never in a project or undo history. Export reads
 * them through `renderCacheConfig()` (registered below).
 */

/** Budget choices the Export tab offers (bytes). */
export const RENDER_CACHE_BUDGETS = [512, 1024, 2048, 4096, 8192].map((mb) => mb * 1024 ** 2);

export interface RenderCacheSettings {
  enabled: boolean;
  smartRender: boolean;
  budgetBytes: number;
  /** Keep composed preview frames in GPU memory (RAM preview). */
  previewCache: boolean;
  /** Fill the preview cache ahead of the playhead while paused (opt-in). */
  backgroundRender: boolean;
}

export const DEFAULT_RENDER_CACHE_SETTINGS: RenderCacheSettings = {
  ...DEFAULT_RENDER_CACHE_CONFIG,
  previewCache: true,
  backgroundRender: false,
};

/** Coerce a stored value; anything malformed falls back field by field. */
export function sanitizeRenderCacheSettings(value: unknown): RenderCacheSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof RenderCacheSettings, unknown>>;
  const bool = (key: 'enabled' | 'smartRender' | 'previewCache' | 'backgroundRender') =>
    typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_RENDER_CACHE_SETTINGS[key];
  const budget =
    typeof raw.budgetBytes === 'number' && Number.isFinite(raw.budgetBytes) && raw.budgetBytes >= 64 * 1024 ** 2
      ? Math.min(raw.budgetBytes, 64 * 1024 ** 3)
      : DEFAULT_RENDER_CACHE_SETTINGS.budgetBytes;
  return {
    enabled: bool('enabled'),
    smartRender: bool('smartRender'),
    budgetBytes: budget,
    previewCache: bool('previewCache'),
    backgroundRender: bool('backgroundRender'),
  };
}

function load(): RenderCacheSettings {
  const stored = safeGet('renderCache');
  if (!stored) return DEFAULT_RENDER_CACHE_SETTINGS;
  try {
    return sanitizeRenderCacheSettings(JSON.parse(stored));
  } catch {
    return DEFAULT_RENDER_CACHE_SETTINGS;
  }
}

export interface RenderCacheState {
  settings: RenderCacheSettings;
  /** The shared cache's usage once opened (null until the first open). */
  usage: RenderCacheUsage | null;
  /** `navigator.storage.estimate()` for this origin, when known. */
  storage: { usage: number; quota: number } | null;
  update: (patch: Partial<RenderCacheSettings>) => void;
  /** Open the cache (if needed) and read usage + the storage estimate. */
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
}

async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return null;
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}

export const renderCacheStore = createStore<RenderCacheState>()((set, get) => ({
  settings: load(),
  usage: null,
  storage: null,
  update: (patch) => {
    const settings = sanitizeRenderCacheSettings({ ...get().settings, ...patch });
    set({ settings });
    safeSet('renderCache', JSON.stringify(settings));
    if (patch.budgetBytes !== undefined) {
      void sharedRenderCache()
        .then((cache) => cache.setBudget(settings.budgetBytes))
        .catch(() => undefined);
    }
  },
  refresh: async () => {
    const cache = await sharedRenderCache();
    set({ usage: cache.usage(), storage: await storageEstimate() });
  },
  clear: async () => {
    const cache = await sharedRenderCache();
    await cache.clear();
    set({ usage: cache.usage(), storage: await storageEstimate() });
  },
}));

registerRenderCacheConfigSource(() => {
  const { enabled, smartRender, budgetBytes } = renderCacheStore.getState().settings;
  return { enabled, smartRender, budgetBytes };
});
onRenderCacheUsage((usage) => renderCacheStore.setState({ usage }));

export function useRenderCacheStore<T>(selector: (s: RenderCacheState) => T): T {
  return useStore(renderCacheStore, selector);
}
