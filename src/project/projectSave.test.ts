import { describe, it, expect } from 'vitest';
import {
  summarizeProjectForSave,
  EMPTY_PROJECT_SAVE_MESSAGE,
  describeProjectSaveExportStatus,
  describeProjectSaveSuccessMessage,
  describeRemoteSaveSuccessMessage,
} from './projectSave';

describe('projectSave', () => {
  it('treats projects with no clips or overlays as empty', () => {
    const summary = summarizeProjectForSave([], [{ afterClipIndex: 1, type: 'dissolve', duration: 0.5 }], []);
    expect(summary.isEmpty).toBe(true);
  });

  it('detects non-empty projects with clips or overlays', () => {
    expect(summarizeProjectForSave([{ id: 'a' } as never], [], []).isEmpty).toBe(false);
    expect(summarizeProjectForSave([], [], [{ id: 't' } as never]).isEmpty).toBe(false);
  });

  it('uses accurate export and success messaging', () => {
    const withClips = summarizeProjectForSave([{ id: 'a' } as never, { id: 'b' } as never], [], []);
    expect(describeProjectSaveExportStatus(withClips)).toContain('embedded source media');
    expect(describeProjectSaveSuccessMessage(withClips)).toContain('2 clips');
    expect(describeProjectSaveSuccessMessage(withClips)).toContain('embedded source media');

    const overlaysOnly = summarizeProjectForSave([], [], [{ id: 't' } as never]);
    expect(describeProjectSaveExportStatus(overlaysOnly)).not.toContain('source media');
    expect(describeProjectSaveSuccessMessage(overlaysOnly)).toContain('no source media to embed');

    expect(EMPTY_PROJECT_SAVE_MESSAGE).toContain('empty');
    expect(describeRemoteSaveSuccessMessage('demo', overlaysOnly)).toContain('text overlays only');
  });
});
