import { describe, it, expect } from 'vitest';
import type { Clip, Track } from '../types';
import { buildVideoStack, placementWindow, stackFromTracks, withPlacement } from './trackStacking';
import {
  acceptsClipKind,
  addTrack,
  canRemoveTrack,
  createDefaultTracks,
  isClipLocked,
  MAIN_VIDEO_TRACK_ID,
  MAX_TRACK_HEIGHT,
  migrateLegacyClipsToTracks,
  MIN_TRACK_HEIGHT,
  moveClipBetweenTracks,
  moveClipToVideoLayer,
  nextTrackLabel,
  OVERLAY_VIDEO_TRACK_ID,
  removeTrack,
  renameTrack,
  setTrackHeight,
  setTrackLocked,
  setTrackMuted,
  toLegacyTimelineView,
  videoTracks,
  visibleTextOverlays,
} from './trackModel';
import { buildPreviewCompositionPlan } from './previewComposition';

function makeClip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File([], `${id}.mp4`),
    objectUrl: `blob:${id}`,
    title: id,
    kind: 'video',
    duration,
    trimStart: 0,
    trimEnd: NaN,
    videoFadeIn: 0,
    videoFadeOut: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    ...overrides,
  };
}

/** Default lanes with `base` on V1 and `overlay` on V2 at `overlayStart`. */
function twoLaneTracks(overlayStart: number): Track[] {
  const tracks = createDefaultTracks();
  tracks[0] = { ...tracks[0], items: [{ clipId: 'base', startTime: 0 }] };
  tracks[1] = { ...tracks[1], items: [{ clipId: 'overlay', startTime: overlayStart }] };
  return tracks;
}

describe('buildVideoStack', () => {
  it('derives layerIndex from video track order, bottom-up', () => {
    let tracks = twoLaneTracks(0);
    tracks = addTrack(tracks, 'video');
    tracks = tracks.map((t) =>
      t.id === videoTracks(tracks)[2].id
        ? { ...t, items: [{ clipId: 'top', startTime: 2 }] }
        : t,
    );

    const clips = [makeClip('base', 10), makeClip('overlay', 4), makeClip('top', 3)];
    const stack = buildVideoStack(tracks, clips);

    expect(stack.map((p) => [p.clip.id, p.layerIndex])).toEqual([
      ['base', 0],
      ['overlay', 1],
      ['top', 2],
    ]);
  });

  it('ignores audio and text lanes and skips placements with no clip', () => {
    let tracks = twoLaneTracks(0);
    tracks = addTrack(tracks, 'text');
    tracks = tracks.map((t) =>
      t.kind === 'audio' ? { ...t, items: [{ clipId: 'bed', startTime: 0 }] } : t,
    );
    tracks[0].items.push({ clipId: 'ghost', startTime: 9 });

    const stack = buildVideoStack(tracks, [makeClip('base', 10), makeClip('overlay', 4)]);
    expect(stack.map((p) => p.clip.id)).toEqual(['base', 'overlay']);
  });

  it('carries the holding lane mute / lock flags onto each placement', () => {
    let tracks = twoLaneTracks(5);
    tracks = setTrackMuted(tracks, OVERLAY_VIDEO_TRACK_ID, true);
    tracks = setTrackLocked(tracks, MAIN_VIDEO_TRACK_ID, true);

    const stack = buildVideoStack(tracks, [makeClip('base', 10), makeClip('overlay', 4)]);
    expect(stack[0]).toMatchObject({ layerIndex: 0, muted: false, locked: true });
    expect(stack[1]).toMatchObject({ layerIndex: 1, muted: true, locked: false });
  });
});

describe('stackFromTracks', () => {
  const clips = [makeClip('base', 10), makeClip('overlay', 4)];

  it('reports an overlay only inside its [startTime, startTime + duration) window', () => {
    const tracks = twoLaneTracks(5);
    expect(stackFromTracks(tracks, clips, 4.9)).toEqual([]);
    expect(stackFromTracks(tracks, clips, 5).map((p) => p.clip.id)).toEqual(['overlay']);
    expect(stackFromTracks(tracks, clips, 8.9).map((p) => p.clip.id)).toEqual(['overlay']);
    expect(stackFromTracks(tracks, clips, 9)).toEqual([]);
  });

  it('never reports base-sequence placements (transition math owns those)', () => {
    const tracks = twoLaneTracks(0);
    expect(stackFromTracks(tracks, clips, 1).map((p) => p.clip.id)).toEqual(['overlay']);
  });
});

describe('toLegacyTimelineView placement stamping', () => {
  it('stamps timelineStart from the track item, not output time 0', () => {
    const view = toLegacyTimelineView(twoLaneTracks(5), [
      makeClip('base', 10),
      makeClip('overlay', 4),
    ]);
    expect(view.find((c) => c.id === 'overlay')).toMatchObject({
      layerIndex: 1,
      timelineStart: 5,
    });
  });

  it('stamps trackMuted / trackLocked and clears them when the flag is dropped', () => {
    const clips = [makeClip('base', 10), makeClip('overlay', 4)];
    const muted = setTrackMuted(twoLaneTracks(5), OVERLAY_VIDEO_TRACK_ID, true);
    expect(toLegacyTimelineView(muted, clips).find((c) => c.id === 'overlay')?.trackMuted).toBe(
      true,
    );

    const unmuted = setTrackMuted(muted, OVERLAY_VIDEO_TRACK_ID, false);
    expect(
      toLegacyTimelineView(unmuted, clips).find((c) => c.id === 'overlay'),
    ).not.toHaveProperty('trackMuted');
  });

  it('returns a reference-stable array for the same inputs', () => {
    const tracks = twoLaneTracks(5);
    const clips = [makeClip('base', 10), makeClip('overlay', 4)];
    expect(toLegacyTimelineView(tracks, clips)).toBe(toLegacyTimelineView(tracks, clips));
  });

  it('migrates legacy projects without tracks and keeps overlays at output 0', () => {
    const clips = [makeClip('a', 5), makeClip('pip', 2, { layerIndex: 1 })];
    const tracks = migrateLegacyClipsToTracks(clips, []);
    const view = toLegacyTimelineView(tracks, clips);

    expect(view.find((c) => c.id === 'a')).toMatchObject({ layerIndex: 0, timelineStart: 0 });
    expect(view.find((c) => c.id === 'pip')).toMatchObject({ layerIndex: 1, timelineStart: 0 });
  });
});

describe('withPlacement / placementWindow', () => {
  it('keeps the clip reference when nothing would change', () => {
    const clip = makeClip('a', 3, { layerIndex: 1, timelineStart: 2 });
    expect(
      withPlacement(clip, { layerIndex: 1, startTime: 2, muted: false, locked: false }),
    ).toBe(clip);
  });

  it('falls back to output 0 for clips with no derived placement', () => {
    expect(placementWindow(makeClip('a', 3), 3)).toEqual({ start: 0, end: 3 });
  });
});

describe('preview composition honours track placement', () => {
  it('draws an overlay at its lane start time and extends the output to cover it', () => {
    const clips = [makeClip('base', 3), makeClip('overlay', 2)];
    const view = toLegacyTimelineView(twoLaneTracks(5), clips);
    const at = (time: number) =>
      buildPreviewCompositionPlan(view, [], [], [], undefined, time);

    // The overlay sits past the 3s base sequence, so the output runs to 7s.
    expect(at(0).totalDuration).toBeCloseTo(7, 5);
    expect(at(1).layers.map((l) => ('clipId' in l ? l.clipId : null))).toEqual(['base']);
    expect(at(5.5).layers.map((l) => ('clipId' in l ? l.clipId : null))).toEqual(['overlay']);
    expect(at(6.9).layers.map((l) => ('clipId' in l ? l.clipId : null))).toEqual(['overlay']);
    expect(at(7).layers).toEqual([]);
  });
});

describe('lane chrome', () => {
  it('adds video lanes above the existing ones and audio lanes at the end', () => {
    const tracks = addTrack(createDefaultTracks(), 'video');
    expect(tracks.map((t) => t.kind)).toEqual(['video', 'video', 'video', 'audio']);
    expect(tracks[2].label).toBe('Video 3');

    const withAudio = addTrack(tracks, 'audio');
    expect(withAudio[withAudio.length - 1].label).toBe('Audio 2');
    expect(nextTrackLabel(withAudio, 'text')).toBe('Titles 1');
  });

  it('gives every new lane a unique id', () => {
    const tracks = addTrack(addTrack(createDefaultTracks(), 'video'), 'video');
    expect(new Set(tracks.map((t) => t.id)).size).toBe(tracks.length);
  });

  it('keeps the main video lane, the last video lane and locked lanes', () => {
    const tracks = createDefaultTracks();
    expect(removeTrack(tracks, MAIN_VIDEO_TRACK_ID)).toBe(tracks);
    expect(canRemoveTrack(tracks, MAIN_VIDEO_TRACK_ID)).toBe(false);

    expect(removeTrack(tracks, OVERLAY_VIDEO_TRACK_ID)).not.toBe(tracks);
    const locked = setTrackLocked(tracks, OVERLAY_VIDEO_TRACK_ID, true);
    expect(removeTrack(locked, OVERLAY_VIDEO_TRACK_ID)).toBe(locked);

    const onlyVideo = tracks.filter((t) => t.id !== OVERLAY_VIDEO_TRACK_ID);
    const renamedMain = onlyVideo.map((t) =>
      t.id === MAIN_VIDEO_TRACK_ID ? { ...t, id: 'vx' } : t,
    );
    expect(removeTrack(renamedMain, 'vx')).toBe(renamedMain);
  });

  it('toggles mute and lock without touching other lanes', () => {
    const tracks = createDefaultTracks();
    const muted = setTrackMuted(tracks, OVERLAY_VIDEO_TRACK_ID, true);
    expect(muted.find((t) => t.id === OVERLAY_VIDEO_TRACK_ID)?.muted).toBe(true);
    expect(muted.find((t) => t.id === MAIN_VIDEO_TRACK_ID)).toBe(
      tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID),
    );
    expect(
      setTrackMuted(muted, OVERLAY_VIDEO_TRACK_ID, false).find(
        (t) => t.id === OVERLAY_VIDEO_TRACK_ID,
      ),
    ).not.toHaveProperty('muted');
  });

  it('clamps lane height and renames lanes', () => {
    const tracks = createDefaultTracks();
    expect(setTrackHeight(tracks, MAIN_VIDEO_TRACK_ID, 4)[0].height).toBe(MIN_TRACK_HEIGHT);
    expect(setTrackHeight(tracks, MAIN_VIDEO_TRACK_ID, 9999)[0].height).toBe(MAX_TRACK_HEIGHT);
    expect(renameTrack(tracks, MAIN_VIDEO_TRACK_ID, '  Cam A  ')[0].label).toBe('Cam A');
    expect(renameTrack(tracks, MAIN_VIDEO_TRACK_ID, '   ')[0].label).toBe('Video 1');
  });

  it('reports a clip as locked via its holding lane', () => {
    const tracks = setTrackLocked(twoLaneTracks(5), OVERLAY_VIDEO_TRACK_ID, true);
    expect(isClipLocked(tracks, 'overlay')).toBe(true);
    expect(isClipLocked(tracks, 'base')).toBe(false);
    expect(isClipLocked(tracks, 'missing')).toBe(false);
  });
});

describe('drop rules', () => {
  const clips = [makeClip('base', 10), makeClip('bed', 8, { kind: 'audio' })];

  it('rejects a clip whose kind the lane cannot hold', () => {
    const tracks = twoLaneTracks(0);
    expect(acceptsClipKind(tracks[2], 'audio')).toBe(true);
    expect(acceptsClipKind(tracks[2], 'video')).toBe(false);
    expect(acceptsClipKind(tracks[0], 'audio')).toBe(false);

    expect(moveClipBetweenTracks(tracks, 'base', tracks[2].id, 1, clips)).toBe(tracks);
  });

  it('rejects a move onto or off a locked lane', () => {
    const lockedTarget = setTrackLocked(twoLaneTracks(0), OVERLAY_VIDEO_TRACK_ID, true);
    expect(moveClipBetweenTracks(lockedTarget, 'base', OVERLAY_VIDEO_TRACK_ID, 2, clips)).toBe(
      lockedTarget,
    );

    const lockedSource = setTrackLocked(twoLaneTracks(0), MAIN_VIDEO_TRACK_ID, true);
    expect(moveClipBetweenTracks(lockedSource, 'base', OVERLAY_VIDEO_TRACK_ID, 2, clips)).toBe(
      lockedSource,
    );
  });

  it('places an accepted clip at the requested start time', () => {
    const moved = moveClipBetweenTracks(twoLaneTracks(0), 'base', OVERLAY_VIDEO_TRACK_ID, 4, clips);
    expect(moved.find((t) => t.id === OVERLAY_VIDEO_TRACK_ID)?.items).toEqual([
      { clipId: 'overlay', startTime: 0 },
      { clipId: 'base', startTime: 4 },
    ]);
    expect(moved.find((t) => t.id === MAIN_VIDEO_TRACK_ID)?.items).toEqual([]);
  });
});

describe('moveClipToVideoLayer', () => {
  it('creates lanes as needed and preserves the clip start time', () => {
    const clips = [makeClip('base', 10), makeClip('overlay', 4)];
    const moved = moveClipToVideoLayer(twoLaneTracks(5), 'overlay', 3, clips);

    expect(videoTracks(moved).length).toBe(4);
    expect(videoTracks(moved)[3].items).toEqual([{ clipId: 'overlay', startTime: 5 }]);
    expect(toLegacyTimelineView(moved, clips).find((c) => c.id === 'overlay')?.layerIndex).toBe(3);
  });

  it('is a no-op when the clip already sits on that lane', () => {
    const tracks = twoLaneTracks(5);
    expect(moveClipToVideoLayer(tracks, 'overlay', 1, [])).toBe(tracks);
  });
});

describe('visibleTextOverlays', () => {
  const overlays = [{ id: 'o1' }, { id: 'o2' }];

  it('hides only overlays placed on a muted titles lane', () => {
    let tracks = addTrack(createDefaultTracks(), 'text');
    const laneId = tracks[tracks.length - 1].id;
    tracks = tracks.map((t) =>
      t.id === laneId ? { ...t, items: [{ clipId: 'o1', startTime: 0 }] } : t,
    );

    expect(visibleTextOverlays(tracks, overlays)).toBe(overlays);
    expect(visibleTextOverlays(setTrackMuted(tracks, laneId, true), overlays)).toEqual([
      { id: 'o2' },
    ]);
  });
});
