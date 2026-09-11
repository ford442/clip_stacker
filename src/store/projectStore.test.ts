import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STORAGE_ENDPOINT,
  __resetProjectStoreForTests,
  projectActions,
  projectStore,
} from './projectStore';
import { STORAGE_AUTH_TOKEN_KEY } from '../utils/storageAuth';

describe('projectStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    __resetProjectStoreForTests();
  });

  it('defaults to the shared storage endpoint', () => {
    expect(projectStore.getState().storageEndpoint).toBe(DEFAULT_STORAGE_ENDPOINT);
  });

  it('updates the endpoint', () => {
    projectActions.setStorageEndpoint('https://example.test/hook');
    expect(projectStore.getState().storageEndpoint).toBe('https://example.test/hook');
  });

  it('mirrors the auth token into sessionStorage', () => {
    projectActions.setStorageAuthToken('secret-token');

    expect(projectStore.getState().storageAuthToken).toBe('secret-token');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBe('secret-token');
  });

  it('clears the persisted token when set to empty', () => {
    projectActions.setStorageAuthToken('secret-token');
    projectActions.setStorageAuthToken('');

    expect(projectStore.getState().storageAuthToken).toBe('');
    expect(sessionStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
  });

  it('never leaves the token in localStorage', () => {
    projectActions.setStorageAuthToken('secret-token');
    expect(localStorage.getItem(STORAGE_AUTH_TOKEN_KEY)).toBeNull();
  });
});
