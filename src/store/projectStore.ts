import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { readStorageAuthToken, writeStorageAuthToken } from '../utils/storageAuth';

/** Remote storage endpoint used when no project-specific one has been set. */
export const DEFAULT_STORAGE_ENDPOINT =
  'https://storage.noahcohn.com/webhook/clip-stacker';

/**
 * Read the persisted auth token, tolerating environments without Web Storage
 * (worker bundles, node scripts) since this runs at module import rather than
 * inside a component render.
 */
function initialAuthToken(): string {
  try {
    return readStorageAuthToken();
  } catch {
    return '';
  }
}

/**
 * Remote-storage connection settings (#144).
 *
 * Previously `useState` in `App.tsx`, threaded through `AppShell` into
 * `StorageRow` and `MediaLibraryPanel`. Those panels now subscribe directly,
 * and `useInspectorActions` reads the endpoint straight from the store instead
 * of receiving it as an argument.
 */
export interface ProjectState {
  storageEndpoint: string;
  storageAuthToken: string;

  setStorageEndpoint: (endpoint: string) => void;
  /** Updates the token and mirrors it into sessionStorage. */
  setStorageAuthToken: (token: string) => void;
}

export const projectStore = createStore<ProjectState>()((set) => ({
  storageEndpoint: DEFAULT_STORAGE_ENDPOINT,
  storageAuthToken: initialAuthToken(),

  setStorageEndpoint: (endpoint) => set({ storageEndpoint: endpoint }),
  setStorageAuthToken: (token) => {
    writeStorageAuthToken(token);
    set({ storageAuthToken: token });
  },
}));

/** Stable action references — safe to call without subscribing. */
export const projectActions: Pick<
  ProjectState,
  'setStorageEndpoint' | 'setStorageAuthToken'
> = projectStore.getState();

export const useStorageEndpoint = () =>
  useStore(projectStore, (s) => s.storageEndpoint);
export const useStorageAuthToken = () =>
  useStore(projectStore, (s) => s.storageAuthToken);

/** Test-only reset so specs start from a clean store. */
export function __resetProjectStoreForTests(): void {
  projectStore.setState({
    storageEndpoint: DEFAULT_STORAGE_ENDPOINT,
    storageAuthToken: '',
  });
}
