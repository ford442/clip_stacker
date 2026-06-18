/** sessionStorage key for the remote storage auth token (tab-scoped). */
export const STORAGE_AUTH_TOKEN_KEY = 'clip_stacker:storage_auth_token';

/**
 * Read the storage auth token from sessionStorage, migrating once from legacy
 * localStorage if present.
 */
export function readStorageAuthToken(): string {
  const fromSession = sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY);
  if (fromSession) return fromSession;

  const legacy = localStorage.getItem(STORAGE_AUTH_TOKEN_KEY);
  if (legacy) {
    sessionStorage.setItem(STORAGE_AUTH_TOKEN_KEY, legacy);
    localStorage.removeItem(STORAGE_AUTH_TOKEN_KEY);
    return legacy;
  }

  return '';
}

/** Persist or clear the storage auth token in sessionStorage only. */
export function writeStorageAuthToken(value: string): void {
  if (value) {
    sessionStorage.setItem(STORAGE_AUTH_TOKEN_KEY, value);
  } else {
    sessionStorage.removeItem(STORAGE_AUTH_TOKEN_KEY);
  }
  // Never leave a copy in localStorage.
  localStorage.removeItem(STORAGE_AUTH_TOKEN_KEY);
}
