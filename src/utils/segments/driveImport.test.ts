import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveMediaItem } from '../../types';

const pick = vi.hoisted(() => vi.fn());
vi.mock('../googleDrive', () => ({ pickDriveFiles: pick }));

import { driveLibraryStore } from '../../store/driveLibraryStore';
import { importFromDrive } from './driveImport';

const item = (fileId: string): DriveMediaItem => ({ kind: 'drive', fileId, name: `${fileId}.mp4`, size: 5_000_000_000, mimeType: 'video/mp4' });

beforeEach(() => {
  localStorage.clear();
  driveLibraryStore.setState({ items: [] });
  pick.mockReset();
});

describe('importFromDrive', () => {
  it('adds only references to the library and says nothing was downloaded', async () => {
    pick.mockResolvedValue([item('a'), item('b')]);
    const message = await importFromDrive();
    expect(message).toBe('Added 2 Drive files to the media library — references only, nothing was downloaded.');
    expect(driveLibraryStore.getState().items).toEqual([item('a'), item('b')]);
  });

  it('counts files that were already imported as refreshed, not added', async () => {
    pick.mockResolvedValue([item('a')]);
    await importFromDrive();
    pick.mockResolvedValue([item('a'), item('c')]);
    expect(await importFromDrive()).toContain('Added 1 Drive file to the media library (1 already there, refreshed)');
  });

  it('leaves the library alone when the picker is cancelled', async () => {
    pick.mockResolvedValue([]);
    expect(await importFromDrive()).toBe('No Drive files were added.');
    expect(driveLibraryStore.getState().items).toEqual([]);
  });

  it('lets configuration and sign-in errors through for the caller to show', async () => {
    pick.mockRejectedValue(new Error('Google Drive import is not configured.'));
    await expect(importFromDrive()).rejects.toThrow('not configured');
  });
});
