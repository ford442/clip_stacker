import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STORAGE_AUTH_TOKEN_KEY,
  readStorageAuthToken,
  writeStorageAuthToken,
} from './storageAuth';

describe('storageAuth', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
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

  it('prefers sessionStorage over legacy localStorage', () => {
    sessionStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'session-token');
    localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'legacy-token');
    expect(readStorageAuthToken()).toBe('session-token');
  });

  it('migrates a legacy localStorage token into sessionStorage', () => {
    localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'legacy-token');
    expect(readStorageAuthToken()).toBe('legacy-token');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBe('legacy-token');
    expect(localStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
  });

  it('writes tokens to sessionStorage only', () => {
    writeStorageAuthToken('new-token');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBe('new-token');
    expect(localStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
  });

  it('clears sessionStorage and any legacy localStorage copy', () => {
    sessionStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'session-token');
    localStorage.setItem(STORAGE_AUTH_TOKEN_KEY, 'legacy-token');
    writeStorageAuthToken('');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
  });
});
