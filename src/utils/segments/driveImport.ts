import { driveLibraryActions } from '../../store/driveLibraryStore';
import { pickDriveFiles } from '../googleDrive';

/**
 * "Import from Drive": let the user pick audio/video in Drive and add
 * *references* to the media library. Nothing is downloaded. Resolves with a
 * message for the status line.
 */
export async function importFromDrive(): Promise<string> {
  const picked = await pickDriveFiles();
  if (picked.length === 0) return 'No Drive files were added.';
  const added = driveLibraryActions.addItems(picked);
  const refreshed = picked.length - added;
  return (
    `Added ${added} Drive file${added === 1 ? '' : 's'} to the media library` +
    (refreshed > 0 ? ` (${refreshed} already there, refreshed)` : '') +
    ' — references only, nothing was downloaded.'
  );
}
