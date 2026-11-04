import { STORAGE_KEYS, safeGet, safeRemove, safeSet } from '../utils/storageKeys';

/** sessionStorage key for the remote storage auth token (tab-scoped). */
export const STORAGE_AUTH_TOKEN_KEY = STORAGE_KEYS.storageAuthToken.key;

/**
 * Read the storage auth token from sessionStorage, migrating once from legacy
 * localStorage if present. Returns '' when storage is blocked.
 */
export function readStorageAuthToken(): string {
  const fromSession = safeGet('storageAuthToken');
  if (fromSession) return fromSession;

  const legacy = safeGet('legacyLocalStorageAuthToken');
  if (legacy) {
    safeSet('storageAuthToken', legacy);
    safeRemove('legacyLocalStorageAuthToken');
    return legacy;
  }

  return '';
}

/**
 * Persist or clear the storage auth token in sessionStorage only. Best
 * effort: a blocked storage means the token lives for this page only, and
 * this never throws (callers run it before updating their own state).
 */
export function writeStorageAuthToken(value: string): void {
  if (value) {
    safeSet('storageAuthToken', value);
  } else {
    safeRemove('storageAuthToken');
  }
  // Never leave a copy in localStorage.
  safeRemove('legacyLocalStorageAuthToken');
}
