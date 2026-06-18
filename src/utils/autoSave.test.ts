import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Clip } from '../types';
import { DEFAULT_EXPORT_SETTINGS } from '../types';
import {
  AUTO_SAVE_STORAGE_KEY,
  buildAutoSaveProject,
  buildAutoSaveSession,
  clearAutoSave,
  readAutoSaveOffer,
  readAutoSaveSession,
  sessionHasRecoverableWork,
  writeAutoSaveSession,
} from './autoSave';
import { serializeProject } from './project';

function makeClip(id: string, size = 32): Clip {
  const file = new File([new Uint8Array(size)], `${id}.mp4`, { type: 'video/mp4' });
  return {
    id,
    file,
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration: 2,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('autoSave', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('embeds small local clips within the autosave budget', async () => {
    const clips = [makeClip('a', 64)];
    const project = await buildAutoSaveProject(clips, [], [], []);

    expect(project.mediaMode).toBe('embed');
    expect(project.clips[0].sourceMediaDataUrl).toMatch(/^data:video\/mp4;base64,/);
  });

  it('uses remote source URLs without embedding', async () => {
    const clip = {
      ...makeClip('remote'),
      remoteSourceUrl: 'https://example.com/clip.mp4',
    };
    const project = await buildAutoSaveProject([clip], [], [], []);

    expect(project.mediaMode).toBe('remote');
    expect(project.clips[0].sourceMediaUrl).toBe('https://example.com/clip.mp4');
    expect(project.clips[0].sourceMediaDataUrl).toBeUndefined();
  });

  it('falls back to metadata-only when forceMetadataOnly is set', async () => {
    const clips = [makeClip('meta', 64)];
    const project = await buildAutoSaveProject(clips, [], [], [], {
      forceMetadataOnly: true,
    });

    expect(project.mediaMode).toBe('metadata');
    expect(project.clips[0].sourceMediaDataUrl).toBeUndefined();
  });

  it('writes and reads autosave sessions from localStorage', () => {
    const clips = [makeClip('a')];
    const project = serializeProject(clips, [], [], []);
    const session = buildAutoSaveSession(project, 'a', DEFAULT_EXPORT_SETTINGS);

    const result = writeAutoSaveSession(session);
    expect(result.ok).toBe(true);

    const restored = readAutoSaveSession();
    expect(restored?.selectedClipId).toBe('a');
    expect(restored?.project.clips).toHaveLength(1);
  });

  it('builds a recovery offer for non-empty sessions', () => {
    const clips = [makeClip('a'), makeClip('b')];
    const project = serializeProject(clips, [], [], []);
    const session = buildAutoSaveSession(project, null, DEFAULT_EXPORT_SETTINGS);
    writeAutoSaveSession(session);

    const offer = readAutoSaveOffer();
    expect(offer?.clipCount).toBe(2);
    expect(sessionHasRecoverableWork(session)).toBe(true);
  });

  it('clears autosave storage', () => {
    const session = buildAutoSaveSession(serializeProject([makeClip('a')], [], [], []), null, DEFAULT_EXPORT_SETTINGS);
    writeAutoSaveSession(session);
    clearAutoSave();
    expect(localStorage.getItem(AUTO_SAVE_STORAGE_KEY)).toBeNull();
  });
});
