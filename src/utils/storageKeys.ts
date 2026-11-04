/**
 * Every browser-storage key the app uses, and the only code that touches
 * `localStorage` / `sessionStorage`.
 *
 * Storage can throw on *access* (blocked site data, some private windows), on
 * write (quota) and on remove, so every helper here catches and reports
 * instead of throwing. Nothing that reaches storage may run before a store
 * `set` or a React state update: a blocked storage must only mean "not
 * remembered".
 *
 * Keys follow `clip_stacker.<name>.v<n>`. Keys that predate the scheme are
 * listed in `legacy`: a read falls back to them and moves the value to the
 * current key, and a write or remove clears them, so no saved value is lost
 * by the rename.
 */

/** `removeItem` is optional so minimal fakes (tests) fit; a missing one cannot remove. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'> &
  Partial<Pick<Storage, 'removeItem'>>;

export type StorageArea = 'local' | 'session';

export interface StorageKeySpec {
  key: string;
  /** Older names, read once and then removed. Same area as `key`. */
  legacy: readonly string[];
  area: StorageArea;
}

export const STORAGE_KEYS = {
  /** Autosaved project session (`utils/autoSave.ts`). */
  autoSave: {
    key: 'clip_stacker.autosave.v1',
    legacy: ['clip_stacker_autosave_v1'],
    area: 'local',
  },
  /** In-flight chunked upload sessions (`utils/storageUpload.ts`). */
  uploadSessions: {
    key: 'clip_stacker.uploadSessions.v1',
    legacy: ['clip_stacker_upload_sessions_v1'],
    area: 'local',
  },
  /** Workspace zone sizes (`utils/workspaceLayout.ts`). View state. */
  workspaceLayout: {
    key: 'clip_stacker.workspaceLayout.v1',
    legacy: [],
    area: 'local',
  },
  /** Inspector section open state (`utils/sectionState.ts`). View state. */
  inspectorSections: {
    key: 'clip_stacker.inspectorSections.v1',
    legacy: [],
    area: 'local',
  },
  /** Whether the LUFS meter is shown (`components/audio/LoudnessMeter.tsx`). */
  loudnessMeter: {
    key: 'clip_stacker.loudnessMeter.v1',
    legacy: [],
    area: 'local',
  },
  /** User finishing presets (`store/finishingPresetStore.ts`). */
  finishingPresets: {
    key: 'clip_stacker.finishingPresets.v1',
    legacy: [],
    area: 'local',
  },
  /** Google Drive library references (`store/driveLibraryStore.ts`). No token. */
  driveLibrary: {
    key: 'clip_stacker.driveLibrary.v1',
    legacy: [],
    area: 'local',
  },
  /** Self-hosted transcription endpoint (`store/settingsStore.ts`). */
  autoCaptionEndpoint: {
    key: 'clip_stacker.autoCaptionEndpoint.v1',
    legacy: ['clipStacker.autoCaptionEndpoint'],
    area: 'local',
  },
  /** Last rate the speed lane was seeded with (`utils/speedLane.ts`). */
  speedLaneSeedRate: {
    key: 'clip_stacker.speedLaneSeedRate.v1',
    legacy: ['clip-stacker:speed-lane-last-seed-rate'],
    area: 'local',
  },
  /** Remote storage auth token — tab-scoped, never in localStorage. */
  storageAuthToken: {
    key: 'clip_stacker.storageAuthToken.v1',
    legacy: ['clip_stacker:storage_auth_token'],
    area: 'session',
  },
  /**
   * Where old builds kept the auth token. Only read to move it into
   * `storageAuthToken` (session) and then removed; never written.
   */
  legacyLocalStorageAuthToken: {
    key: 'clip_stacker:storage_auth_token',
    legacy: [],
    area: 'local',
  },
} as const satisfies Record<string, StorageKeySpec>;

export type StorageKeyName = keyof typeof STORAGE_KEYS;

export interface StorageOptions {
  /** Use this storage instead of the key's area (tests, fakes). `null` = unavailable. */
  storage?: StorageLike | null;
}

export type StorageWriteResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'unavailable' | 'error'; message: string };

/** The browser storage for an area, or null when it is missing or blocked. */
export function storageArea(area: StorageArea): StorageLike | null {
  try {
    const storage = area === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    return storage ?? null;
  } catch {
    // Accessing the property itself throws with blocked site data.
    return null;
  }
}

function resolveStorage(name: StorageKeyName, options?: StorageOptions): StorageLike | null {
  return options && 'storage' in options
    ? options.storage ?? null
    : storageArea(STORAGE_KEYS[name].area);
}

function rawGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function rawRemove(storage: StorageLike, key: string): boolean {
  if (!storage.removeItem) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** True for the DOMException browsers throw when storage is full. */
export function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    // 22 / 1014: legacy WebKit / Firefox codes.
    if (error.code === 22 || error.code === 1014) return true;
  }
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /quota/i.test(name);
}

/**
 * Read a key, falling back to its legacy names. A legacy hit is moved to the
 * current key (best effort) so the next read finds it there.
 */
export function safeGet(name: StorageKeyName, options?: StorageOptions): string | null {
  const storage = resolveStorage(name, options);
  if (!storage) return null;
  const spec: StorageKeySpec = STORAGE_KEYS[name];
  const current = rawGet(storage, spec.key);
  if (current != null) return current;
  for (const legacyKey of spec.legacy) {
    const value = rawGet(storage, legacyKey);
    if (value == null) continue;
    try {
      storage.setItem(spec.key, value);
      rawRemove(storage, legacyKey);
    } catch {
      // Could not move it (quota): keep reading it from the old name.
    }
    return value;
  }
  return null;
}

/** Write a key and clear its legacy names. Never throws. */
export function safeSet(
  name: StorageKeyName,
  value: string,
  options?: StorageOptions,
): StorageWriteResult {
  const storage = resolveStorage(name, options);
  if (!storage) return { ok: false, reason: 'unavailable', message: 'Browser storage is unavailable.' };
  const spec: StorageKeySpec = STORAGE_KEYS[name];
  try {
    storage.setItem(spec.key, value);
  } catch (error) {
    return {
      ok: false,
      reason: isQuotaError(error) ? 'quota' : 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  for (const legacyKey of spec.legacy) rawRemove(storage, legacyKey);
  return { ok: true };
}

/** Remove a key and its legacy names. Returns false when storage refused. Never throws. */
export function safeRemove(name: StorageKeyName, options?: StorageOptions): boolean {
  const storage = resolveStorage(name, options);
  if (!storage) return false;
  const spec: StorageKeySpec = STORAGE_KEYS[name];
  let ok = rawRemove(storage, spec.key);
  for (const legacyKey of spec.legacy) ok = rawRemove(storage, legacyKey) && ok;
  return ok;
}
