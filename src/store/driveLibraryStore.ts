import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { DriveMediaItem } from '../types';

/**
 * Google Drive files the user imported, kept as references — `{ kind: 'drive',
 * fileId, name, size, mimeType }` — never as bytes. Per-browser view state
 * (localStorage), not part of a project or the undo history. Holds no token:
 * the OAuth token lives in memory only (`utils/googleDrive.ts`).
 */

export const DRIVE_LIBRARY_STORAGE_KEY = 'clip_stacker.driveLibrary.v1';

function isDriveMediaItem(value: unknown): value is DriveMediaItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DriveMediaItem>;
  return (
    v.kind === 'drive' &&
    typeof v.fileId === 'string' &&
    v.fileId.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.size === 'number' &&
    typeof v.mimeType === 'string'
  );
}

function load(): DriveMediaItem[] {
  try {
    const raw = localStorage.getItem(DRIVE_LIBRARY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { items?: unknown };
    return Array.isArray(parsed.items) ? parsed.items.filter(isDriveMediaItem) : [];
  } catch {
    return [];
  }
}

function persist(items: DriveMediaItem[]): void {
  try {
    localStorage.setItem(DRIVE_LIBRARY_STORAGE_KEY, JSON.stringify({ version: 1, items }));
  } catch {
    // Quota / private mode: the library still works for this tab.
  }
}

export interface DriveLibraryState {
  items: DriveMediaItem[];
  /** Add or refresh references (matched by `fileId`); returns how many were new. */
  addItems: (items: DriveMediaItem[]) => number;
  removeItem: (fileId: string) => void;
}

export const driveLibraryStore = createStore<DriveLibraryState>()((set, get) => ({
  items: load(),
  addItems: (incoming) => {
    const byId = new Map(get().items.map((item) => [item.fileId, item]));
    let added = 0;
    for (const item of incoming) {
      if (!byId.has(item.fileId)) added += 1;
      byId.set(item.fileId, item);
    }
    const items = [...byId.values()];
    persist(items);
    set({ items });
    return added;
  },
  removeItem: (fileId) => {
    const items = get().items.filter((item) => item.fileId !== fileId);
    persist(items);
    set({ items });
  },
}));

export const driveLibraryActions: Pick<DriveLibraryState, 'addItems' | 'removeItem'> =
  driveLibraryStore.getState();

export const useDriveLibraryItems = () => useStore(driveLibraryStore, (s) => s.items);

/** Test seam: reload from storage. */
export function __reloadDriveLibraryForTests(): void {
  driveLibraryStore.setState({ items: load() });
}
