import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

/**
 * Runtime state for preview proxies (see `utils/proxyMedia.ts`).
 *
 * Ready proxies are keyed by store key (`proxyStoreKey(sourceHash, profile)`),
 * not clip id, so a split — two clips over one file — shares one proxy.
 * Build progress and errors are per clip, because that is what the library
 * row shows. None of this is undoable or serialized: the clip's `proxy`
 * record is the serialized half, the bytes live in the media store.
 */
export interface ReadyProxy {
  blob: Blob;
  /** Object URL for the `<video>` fallback; revoked when the proxy is evicted. */
  objectUrl: string;
  width: number;
  height: number;
}

export interface ProxyState {
  /** "Use proxies for playback". On by default; off decodes originals everywhere. */
  enabled: boolean;
  /** Clip ids waiting to build, oldest first. One builds at a time. */
  queue: string[];
  /** Clip id → 0–1 progress of the build in flight. */
  building: Record<string, { progress: number }>;
  /** Clip id → last build failure. Cleared by the next request. */
  errors: Record<string, string>;
  ready: Record<string, ReadyProxy>;

  setEnabled: (enabled: boolean) => void;
  /** Queue a build for `clipId` (no-op when already queued or building). */
  requestProxy: (clipId: string) => void;
  /** Drop `clipId` from the queue and the in-flight / error maps. */
  forgetClip: (clipId: string) => void;
  /** Move `clipId` from the queue head into the building map. */
  startBuild: (clipId: string) => void;
  setBuildProgress: (clipId: string, progress: number) => void;
  finishBuild: (clipId: string, error?: string) => void;
  setReady: (key: string, blob: Blob, width: number, height: number) => void;
  /** Forget a ready proxy and revoke its URL. Returns the blob, if it was held. */
  evict: (key: string) => Blob | null;
}

function createObjectUrl(blob: Blob): string {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return '';
  }
}

function revokeObjectUrl(url: string): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Non-DOM environments.
  }
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const proxyStore = createStore<ProxyState>()((set, get) => ({
  enabled: true,
  queue: [],
  building: {},
  errors: {},
  ready: {},

  setEnabled: (enabled) => set({ enabled }),

  requestProxy: (clipId) => {
    const s = get();
    if (s.queue.includes(clipId) || s.building[clipId]) return;
    set({ queue: [...s.queue, clipId], errors: without(s.errors, clipId) });
  },

  forgetClip: (clipId) => {
    const s = get();
    set({
      queue: s.queue.filter((id) => id !== clipId),
      building: without(s.building, clipId),
      errors: without(s.errors, clipId),
    });
  },

  startBuild: (clipId) => {
    const s = get();
    set({
      queue: s.queue.filter((id) => id !== clipId),
      building: { ...s.building, [clipId]: { progress: 0 } },
    });
  },

  setBuildProgress: (clipId, progress) => {
    const s = get();
    if (!s.building[clipId]) return;
    set({ building: { ...s.building, [clipId]: { progress } } });
  },

  finishBuild: (clipId, error) => {
    const s = get();
    set({
      building: without(s.building, clipId),
      errors: error ? { ...s.errors, [clipId]: error } : without(s.errors, clipId),
    });
  },

  setReady: (key, blob, width, height) => {
    const s = get();
    const prev = s.ready[key];
    if (prev?.blob === blob) return;
    if (prev) revokeObjectUrl(prev.objectUrl);
    set({ ready: { ...s.ready, [key]: { blob, objectUrl: createObjectUrl(blob), width, height } } });
  },

  evict: (key) => {
    const s = get();
    const prev = s.ready[key];
    if (!prev) return null;
    revokeObjectUrl(prev.objectUrl);
    set({ ready: without(s.ready, key) });
    return prev.blob;
  },
}));

export const proxyActions: Pick<
  ProxyState,
  'setEnabled' | 'requestProxy' | 'forgetClip' | 'startBuild' | 'setBuildProgress' | 'finishBuild' | 'setReady' | 'evict'
> = proxyStore.getState();

export const useProxyState = <T>(selector: (s: ProxyState) => T): T => useStore(proxyStore, selector);
export const useProxiesEnabled = () => useStore(proxyStore, (s) => s.enabled);
