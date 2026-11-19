import { describe, expect, it, vi } from 'vitest';
import type { Clip, Project, SerializedClip, Track } from '../types';

const mediaMocks = vi.hoisted(() => ({ getMediaInfo: vi.fn() }));
vi.mock('../media/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/media')>()),
  getMediaInfo: mediaMocks.getMediaInfo,
}));

import { applyProjectData, createProjectSnapshot, serializeProject } from './index';
import { buildAutoSaveProject } from './autoSave';
import { createOfflineClip, offlineClipsOnUnmutedLanes, offlineExportRefusal, relinkClip } from './offlineClips';
import { createTestClip } from './project.test.helpers';

function saved(id: string, fileName: string, extra: Partial<SerializedClip> = {}): SerializedClip {
  return {
    id,
    title: fileName,
    kind: 'video',
    duration: 8,
    trimStart: 1,
    trimEnd: 5,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    fileName,
    ...extra,
  };
}

const lanes = (clipIds: string[], muted = false): Track[] => [
  { id: 'v1', kind: 'video', items: clipIds.map((clipId, i) => ({ clipId, startTime: i * 4 })), ...(muted ? { muted: true } : {}) },
];

describe('offline clips', () => {
  it('load offline (keeping id, trims and settings) when asked, instead of being skipped', async () => {
    const project: Project = { clips: [saved('c1', 'gone.mp4', { volume: 0.5, stabilize: true })], tracks: lanes(['c1']) };
    const skipped = await applyProjectData(project, []);
    expect(skipped.clips).toHaveLength(0);
    expect(skipped.skippedClipFileNames).toEqual(['gone.mp4']);

    const loaded = await applyProjectData(project, [], { missingMedia: 'offline' });
    const [clip] = loaded.clips;
    expect(loaded.skippedClipCount).toBe(0);
    expect(loaded.offlineClipFileNames).toEqual(['gone.mp4']);
    expect(clip).toMatchObject({ id: 'c1', trimStart: 1, trimEnd: 5, volume: 0.5, stabilize: true, objectUrl: '' });
    expect(clip!.offline).toEqual({ fileName: 'gone.mp4' });
    expect(loaded.tracks[0]!.items[0]!.clipId).toBe('c1');
  });

  it('survive save → load and autosave, and relink by name when the media is back', async () => {
    const offline = { ...createOfflineClip(saved('c1', 'gone.mp4', { offline: { fileName: 'gone.mp4', hash: 'abcdef0123456789' } })), trimStart: 1, trimEnd: 5 };
    const project = serializeProject(createProjectSnapshot({ clips: [offline], tracks: lanes(['c1']) }));
    expect(project.clips[0]!.offline).toEqual({ fileName: 'gone.mp4', hash: 'abcdef0123456789' });

    const autosave = await buildAutoSaveProject(createProjectSnapshot({ clips: [offline], tracks: lanes(['c1']) }));
    expect(autosave.clips[0]!.sourceMediaDataUrl).toBeUndefined();

    // Saved offline: it comes back offline even without the option.
    const reloaded = await applyProjectData(project, []);
    expect(reloaded.clips[0]!.offline?.hash).toBe('abcdef0123456789');

    const live = createTestClip('gone', 8);
    const relinked = await applyProjectData(project, [live]);
    expect(relinked.clips[0]!.offline).toBeUndefined();
    expect(relinked.clips[0]!.file).toBe(live.file);
  });

  it('resolveMedia gives each saved clip its own loaded clip with its saved id', async () => {
    mediaMocks.getMediaInfo.mockReset().mockImplementation(async (file: File) => ({ duration: 9, objectUrl: `blob:${file.name}`, videoWidth: 640, videoHeight: 360, hasAudio: true }));
    const file = new File([new Uint8Array(4)], 'shared.mp4', { type: 'video/mp4' });
    const project: Project = {
      clips: [saved('a', 'shared.mp4'), saved('b', 'shared.mp4', { trimStart: 2, trimEnd: 6 }), saved('c', 'missing.mp4')],
      tracks: lanes(['a', 'b', 'c']),
    };
    const loaded = await applyProjectData(project, [], {
      missingMedia: 'offline',
      resolveMedia: (clip) => (clip.fileName === 'shared.mp4' ? file : null),
    });
    expect(loaded.clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(loaded.clips[0]).not.toBe(loaded.clips[1]);
    expect(loaded.clips.map((c) => [c.trimStart, c.trimEnd])).toEqual([[1, 5], [2, 6], [1, 5]]);
    expect(loaded.clips[0]!.duration).toBe(9);
    expect(loaded.clips[2]!.offline).toEqual({ fileName: 'missing.mp4' });
  });

  it('block an export only on unmuted lanes', () => {
    const offline = createOfflineClip(saved('c1', 'gone.mp4'));
    const live = createTestClip('ok', 4);
    expect(offlineClipsOnUnmutedLanes(lanes(['c1', 'ok']), [offline, live]).map((c) => c.id)).toEqual(['c1']);
    expect(offlineExportRefusal(lanes(['c1']), [offline])).toMatch(/1 offline clip \(gone\.mp4\)/);
    expect(offlineExportRefusal(lanes(['c1'], true), [offline])).toBeNull();
    expect(offlineExportRefusal(lanes(['ok']), [live])).toBeNull();
  });

  it('relink swaps the media in and clamps a trim past its end', () => {
    const offline: Clip = { ...createOfflineClip(saved('c1', 'gone.mp4')), trimStart: 1, trimEnd: 7, volume: 0.25 };
    const file = new File([], 'found.mp4');
    const next = relinkClip(offline, { file, objectUrl: 'blob:found', duration: 6, videoWidth: 1920, videoHeight: 1080, hasAudio: false });
    expect(next).toMatchObject({ id: 'c1', file, objectUrl: 'blob:found', duration: 6, trimStart: 1, trimEnd: 6, volume: 0.25, hasAudio: false });
    expect(next.offline).toBeUndefined();
  });
});

describe('project timecode', () => {
  it('is omitted at the default and restored (coerced) on load', async () => {
    const plain = serializeProject(createProjectSnapshot());
    expect(plain.timecodeStart).toBeUndefined();
    expect(plain.timecodeRate).toBeUndefined();
    const custom = serializeProject(createProjectSnapshot({ timecode: { start: '10:00:00;00', rate: '29.97df' } }));
    expect(custom).toMatchObject({ timecodeStart: '10:00:00;00', timecodeRate: '29.97df' });
    expect((await applyProjectData(custom, [])).timecode).toEqual({ start: '10:00:00;00', rate: '29.97df' });
    const broken = { clips: [], timecodeStart: 'soon', timecodeRate: '33' } as unknown as Project;
    expect((await applyProjectData(broken, [])).timecode).toEqual({ start: '01:00:00:00', rate: '30' });
  });
});
