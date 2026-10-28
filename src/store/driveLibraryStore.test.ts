import { beforeEach, describe, expect, it } from 'vitest';
import type { DriveMediaItem } from '../types';
import {
  __reloadDriveLibraryForTests,
  DRIVE_LIBRARY_STORAGE_KEY,
  driveLibraryActions,
  driveLibraryStore,
} from './driveLibraryStore';

const item = (fileId: string, overrides: Partial<DriveMediaItem> = {}): DriveMediaItem => ({
  kind: 'drive', fileId, name: `${fileId}.mp4`, size: 100, mimeType: 'video/mp4', ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  driveLibraryStore.setState({ items: [] });
});

describe('driveLibraryStore', () => {
  it('stores only the reference fields and survives a reload', () => {
    driveLibraryActions.addItems([item('a'), item('b')]);
    expect(JSON.parse(localStorage.getItem(DRIVE_LIBRARY_STORAGE_KEY)!).items).toEqual([item('a'), item('b')]);
    driveLibraryStore.setState({ items: [] });
    __reloadDriveLibraryForTests();
    expect(driveLibraryStore.getState().items.map((i) => i.fileId)).toEqual(['a', 'b']);
  });

  it('dedupes by fileId, refreshing metadata, and reports how many were new', () => {
    expect(driveLibraryActions.addItems([item('a')])).toBe(1);
    expect(driveLibraryActions.addItems([item('a', { name: 'renamed.mp4' }), item('b')])).toBe(1);
    expect(driveLibraryStore.getState().items).toEqual([item('a', { name: 'renamed.mp4' }), item('b')]);
  });

  it('removes an item', () => {
    driveLibraryActions.addItems([item('a'), item('b')]);
    driveLibraryActions.removeItem('a');
    expect(driveLibraryStore.getState().items.map((i) => i.fileId)).toEqual(['b']);
  });

  it('ignores corrupt or foreign entries when loading', () => {
    localStorage.setItem(
      DRIVE_LIBRARY_STORAGE_KEY,
      JSON.stringify({ items: [item('ok'), { kind: 'drive' }, { kind: 'local', fileId: 'x', name: 'n', size: 1, mimeType: 'm' }, 7] }),
    );
    __reloadDriveLibraryForTests();
    expect(driveLibraryStore.getState().items.map((i) => i.fileId)).toEqual(['ok']);
    localStorage.setItem(DRIVE_LIBRARY_STORAGE_KEY, '{not json');
    __reloadDriveLibraryForTests();
    expect(driveLibraryStore.getState().items).toEqual([]);
  });
});
