import { describe, expect, it, vi } from 'vitest';
import type { Clip } from '../../types';
import { normalizeBaseLane, type EditState } from '../editModeCore';
import { createDefaultTracks } from '../trackModel';
import { replaceSegment, type ReplaceDeps } from './replaceSegment';
import { makeClip } from './segments.test.helpers';

function setup(clip: Clip, readMedia?: ReplaceDeps['readMedia']) {
  const tracks = createDefaultTracks();
  tracks[0] = { ...tracks[0], items: [{ clipId: clip.id, startTime: 0 }] };
  let state: EditState = { tracks: normalizeBaseLane(tracks, [clip], []), clips: [clip], transitions: [] };
  const deps: ReplaceDeps = {
    fetchBlob: vi.fn(async () => new Blob(['processed'], { type: 'video/mp4' })),
    readMedia: readMedia ?? vi.fn(async () => ({ durationSec: 4, objectUrl: 'blob:new', width: 640, height: 360, hasAudio: true })),
    revokeObjectUrl: vi.fn(),
    getEditState: () => state,
    commitEdit: vi.fn((next: EditState) => { state = next; }),
    afterSplit: vi.fn(),
    select: vi.fn(),
  };
  return { deps, get: () => state };
}

const REMOTE = { url: 'https://s/files/clip-stacker/media/seg%20one.mp4', durationSec: 4 };

describe('replaceSegment', () => {
  it('commits one edit, measures the real media, and remembers the library URL', async () => {
    const { deps, get } = setup(makeClip({ trimStart: 2, trimEnd: 6 }));
    const result = await replaceSegment('clip1', { startSec: 2, endSec: 6 }, REMOTE, deps);

    expect(result).toMatchObject({ ok: true, clipId: 'clip1' });
    expect(deps.fetchBlob).toHaveBeenCalledWith(REMOTE.url);
    expect(deps.commitEdit).toHaveBeenCalledTimes(1);
    expect(deps.select).toHaveBeenCalledWith('clip1');
    const clip = get().clips[0];
    expect(clip.file.name).toBe('seg one.mp4');
    expect(clip.remoteSourceUrl).toBe(REMOTE.url);
    expect([clip.trimStart, clip.trimEnd, clip.objectUrl]).toEqual([0, 4, 'blob:new']);
  });

  it('does not remember a blob: URL as a library copy', async () => {
    const { deps, get } = setup(makeClip({ trimStart: 2, trimEnd: 6 }));
    await replaceSegment('clip1', { startSec: 2, endSec: 6 }, { url: 'blob:abc', durationSec: 4 }, deps);
    expect(get().clips[0].remoteSourceUrl).toBeUndefined();
  });

  it('trusts the measured media over the length the result claims', async () => {
    const { deps } = setup(makeClip({ trimStart: 2, trimEnd: 6 }), async () => ({ durationSec: 9, objectUrl: 'blob:new' }));
    const result = await replaceSegment('clip1', { startSec: 2, endSec: 6 }, { ...REMOTE, durationSec: 4 }, deps);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.message).toMatch(/9\.00s but the segment is 4\.00s/);
    expect(deps.commitEdit).not.toHaveBeenCalled();
    expect(deps.revokeObjectUrl).toHaveBeenCalledWith('blob:new');
  });

  it('splits a clip around a sub-range and tells the caller to leave its A/B group', async () => {
    const { deps, get } = setup(makeClip({ groupId: 'g1', groupVariant: 'A' }));
    const result = await replaceSegment('clip1', { startSec: 3, endSec: 7 }, REMOTE, deps);
    expect(result.ok).toBe(true);
    expect(get().clips).toHaveLength(3);
    expect(deps.afterSplit).toHaveBeenCalledWith(expect.objectContaining({ id: 'clip1' }));
    expect(deps.select).toHaveBeenCalledWith(get().clips[1].id);
  });

  it('reports download failures without touching the timeline', async () => {
    const { deps } = setup(makeClip());
    vi.mocked(deps.fetchBlob).mockRejectedValue(new Error('Could not download media after 3 attempts'));
    const result = await replaceSegment('clip1', { startSec: 3, endSec: 7 }, REMOTE, deps);
    expect(result).toEqual({ ok: false, message: 'Could not download media after 3 attempts' });
    expect(deps.commitEdit).not.toHaveBeenCalled();
    expect(deps.revokeObjectUrl).not.toHaveBeenCalled();
  });

  it('refuses a locked or missing clip and frees the object URL it made', async () => {
    const { deps } = setup(makeClip());
    const result = await replaceSegment('gone', { startSec: 3, endSec: 7 }, REMOTE, deps);
    expect(result.ok).toBe(false);
    expect(deps.revokeObjectUrl).toHaveBeenCalledWith('blob:new');
  });
});
