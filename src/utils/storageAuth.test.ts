import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_AUTH_TOKEN_KEY,
  readStorageAuthToken,
  writeStorageAuthToken,
} from './storageAuth';
import { STORAGE_KEYS } from './storageKeys';

/** Where builds before the key rename kept the token (both areas). */
const OLD_KEY = 'clip_stacker:storage_auth_token';
const LEGACY_LOCAL_KEY = STORAGE_KEYS.legacyLocalStorageAuthToken.key;

describe('storageAuth', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('returns an empty string when no token is stored', () => {
    expect(readStorageAuthToken()).toBe('');
  });

  it('reads a token from sessionStorage', () => {
    sessionStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'session-token');
    expect(readStorageAuthToken()).toBe('session-token');
  });

  it('reads a token saved under the old sessionStorage name and moves it', () => {
    sessionStorage.setItem(OLD_KEY, 'old-session-token');
    expect(readStorageAuthToken()).toBe('old-session-token');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBe('old-session-token');
    expect(sessionStorage.getItem(OLD_KEY)).toBeNull();
  });

  it('prefers sessionStorage over legacy localStorage', () => {
    sessionStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'session-token');
    localStorage.setItem(LEGACY_LOCAL_KEY, 'legacy-token');
    expect(readStorageAuthToken()).toBe('session-token');
  });

  it('migrates a legacy localStorage token into sessionStorage', () => {
    localStorage.setItem(LEGACY_LOCAL_KEY, 'legacy-token');
    expect(readStorageAuthToken()).toBe('legacy-token');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBe('legacy-token');
    expect(localStorage.getItem(LEGACY_LOCAL_KEY)).toBeNull();
  });

  it('writes tokens to sessionStorage only', () => {
    writeStorageAuthToken('new-token');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBe('new-token');
    expect(localStorage.getItem(LEGACY_LOCAL_KEY)).toBeNull();
    expect(localStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
  });

  it('clears sessionStorage and any legacy localStorage copy', () => {
    sessionStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'session-token');
    sessionStorage.setItem(OLD_KEY, 'old-session-token');
    localStorage.setItem(LEGACY_LOCAL_KEY, 'legacy-token');
    writeStorageAuthToken('');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(OLD_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LOCAL_KEY)).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
    expect(() => writeStorageAuthToken('token')).not.toThrow();
    expect(() => writeStorageAuthToken('')).not.toThrow();
    expect(readStorageAuthToken()).toBe('');
  });
});
