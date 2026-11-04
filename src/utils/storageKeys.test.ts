import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_KEYS,
  isQuotaError,
  safeGet,
  safeRemove,
  safeSet,
  storageArea,
  type StorageLike,
} from './storageKeys';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function throwingStorage(error: unknown): StorageLike {
  const fail = () => {
    throw error;
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

describe('storageKeys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('names every key clip_stacker.<name>.v<n> (except the read-only legacy token slot)', () => {
    for (const [name, spec] of Object.entries(STORAGE_KEYS)) {
      if (name === 'legacyLocalStorageAuthToken') continue;
      expect(spec.key, name).toMatch(/^clip_stacker\.[A-Za-z]+\.v\d+$/);
    }
    const keys = Object.values(STORAGE_KEYS).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the pre-rename names readable', () => {
    expect(STORAGE_KEYS.autoSave.legacy).toContain('clip_stacker_autosave_v1');
    expect(STORAGE_KEYS.uploadSessions.legacy).toContain('clip_stacker_upload_sessions_v1');
    expect(STORAGE_KEYS.autoCaptionEndpoint.legacy).toContain('clipStacker.autoCaptionEndpoint');
    expect(STORAGE_KEYS.speedLaneSeedRate.legacy).toContain('clip-stacker:speed-lane-last-seed-rate');
    expect(STORAGE_KEYS.storageAuthToken.legacy).toContain('clip_stacker:storage_auth_token');
  });

  it('reads a legacy key and moves it to the current name', () => {
    const storage = memoryStorage();
    storage.setItem('clip_stacker_autosave_v1', '{"old":true}');
    expect(safeGet('autoSave', { storage })).toBe('{"old":true}');
    expect(storage.data.get(STORAGE_KEYS.autoSave.key)).toBe('{"old":true}');
    expect(storage.data.has('clip_stacker_autosave_v1')).toBe(false);
  });

  it('prefers the current key over a legacy one', () => {
    const storage = memoryStorage();
    storage.setItem('clipStacker.autoCaptionEndpoint', 'old');
    storage.setItem(STORAGE_KEYS.autoCaptionEndpoint.key, 'new');
    expect(safeGet('autoCaptionEndpoint', { storage })).toBe('new');
  });

  it('a write and a remove clear legacy names too', () => {
    const storage = memoryStorage();
    storage.setItem('clip-stacker:speed-lane-last-seed-rate', '2');
    expect(safeSet('speedLaneSeedRate', '3', { storage })).toEqual({ ok: true });
    expect(storage.data.has('clip-stacker:speed-lane-last-seed-rate')).toBe(false);
    storage.setItem('clip-stacker:speed-lane-last-seed-rate', '2');
    expect(safeRemove('speedLaneSeedRate', { storage })).toBe(true);
    expect(storage.data.size).toBe(0);
  });

  it('reports quota without throwing', () => {
    const quota = new DOMException('full', 'QuotaExceededError');
    expect(isQuotaError(quota)).toBe(true);
    const result = safeSet('autoSave', 'x', { storage: throwingStorage(quota) });
    expect(result).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('never throws when storage is blocked', () => {
    const blocked = throwingStorage(new DOMException('insecure', 'SecurityError'));
    expect(safeGet('autoSave', { storage: blocked })).toBeNull();
    expect(safeSet('autoSave', 'x', { storage: blocked })).toMatchObject({ ok: false, reason: 'error' });
    expect(safeRemove('autoSave', { storage: blocked })).toBe(false);
    expect(safeGet('autoSave', { storage: null })).toBeNull();
    expect(safeSet('autoSave', 'x', { storage: null })).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('returns null when touching the storage property itself throws', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(storageArea('local')).toBeNull();
    expect(safeGet('workspaceLayout')).toBeNull();
    expect(safeSet('workspaceLayout', '{}')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(safeRemove('workspaceLayout')).toBe(false);
  });

  it('uses the area the key belongs to', () => {
    safeSet('storageAuthToken', 't');
    expect(sessionStorage.getItem(STORAGE_KEYS.storageAuthToken.key)).toBe('t');
    expect(localStorage.getItem(STORAGE_KEYS.storageAuthToken.key)).toBeNull();
  });

  it('is the only module that touches localStorage / sessionStorage', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        if (entry === 'storageKeys.ts') continue;
        const code = readFileSync(path, 'utf8')
          // Comments may mention storage by name.
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        if (/\b(localStorage|sessionStorage)\b/.test(code)) offenders.push(relative(root, path));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
