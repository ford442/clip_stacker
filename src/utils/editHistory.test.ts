import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Clip, ClipGroup } from '../types';
import {
  cloneSnapshot,
  mergeClipUrls,
  revokeOrphanedUrls,
  syncClipGroups,
  trimHistoryStack,
  MAX_EDIT_HISTORY,
} from './editHistory';

function makeClip(id: string, objectUrl = `blob:${id}`): Clip {
  const file = new File(['x'], `${id}.mp4`, { type: 'video/mp4' });
  return {
    id,
    file,
    objectUrl,
    title: id,
    kind: 'video',
    duration: 1,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
  };
}

describe('editHistory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cloneSnapshot copies metadata without sharing nested clip objects', () => {
    const clip = makeClip('a');
    const snapshot = cloneSnapshot({
      clips: [clip],
      clipGroups: [],
      transitions: [],
      textOverlays: [],
      selectedClipId: 'a',
    });

    snapshot.clips[0].title = 'changed';
    expect(clip.title).toBe('a');
    expect(snapshot.clips[0].file).toBe(clip.file);
  });

  it('mergeClipUrls reuses existing object URLs for the same clip id', () => {
    const current = makeClip('a', 'blob:live');
    const restored = [{ ...current, trimStart: 2, objectUrl: 'blob:stale' }];

    const merged = mergeClipUrls(restored, [current]);
    expect(merged[0].objectUrl).toBe('blob:live');
    expect(merged[0].trimStart).toBe(2);
  });

  it('mergeClipUrls recreates object URLs for restored clips', () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new');
    const restored = [makeClip('a', 'blob:dead')];

    const merged = mergeClipUrls(restored, []);
    expect(createSpy).toHaveBeenCalledWith(restored[0].file);
    expect(merged[0].objectUrl).toBe('blob:new');
  });

  it('revokeOrphanedUrls revokes URLs only for removed clips', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const kept = makeClip('keep');
    const removed = makeClip('gone');

    revokeOrphanedUrls([kept, removed], [kept]);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:gone');
  });

  it('syncClipGroups points variants at canonical clips', () => {
    const clip = makeClip('a');
  const groups: ClipGroup[] = [
      {
        id: 'g1',
        activeVariant: 'A',
        variants: { A: { ...clip, title: 'stale' }, B: null },
      },
    ];

    const synced = syncClipGroups(groups, [clip]);
    expect(synced[0].variants.A?.title).toBe('a');
    expect(synced[0].variants.A).toBe(clip);
  });

  it('trimHistoryStack keeps only the newest entries', () => {
    const stack = Array.from({ length: MAX_EDIT_HISTORY + 5 }, (_, i) => i);
    trimHistoryStack(stack);
    expect(stack).toHaveLength(MAX_EDIT_HISTORY);
    expect(stack[0]).toBe(5);
    expect(stack[stack.length - 1]).toBe(MAX_EDIT_HISTORY + 4);
  });
});
