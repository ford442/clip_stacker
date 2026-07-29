import { describe, it, expect } from 'vitest';
import type { Clip, ClipTransition } from '../types';
import {
  createDefaultTracks,
  migrateLegacyClipsToTracks,
  toLegacyTimelineView,
  MAIN_VIDEO_TRACK_ID,
  OVERLAY_VIDEO_TRACK_ID,
} from './trackModel';
import { PROJECT_SCHEMA_VERSION } from '../types';
import { serializeProject, applyProjectData } from './project';

function makeClip(
  id: string,
  duration: number,
  opts: Partial<Clip> = {},
): Clip {
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
    ...opts,
  };
}

describe('trackModel', () => {
  it('createDefaultTracks includes video and audio lanes', () => {
    const tracks = createDefaultTracks();
    expect(tracks.length).toBeGreaterThanOrEqual(3);
    expect(tracks.filter((t) => t.kind === 'video').length).toBeGreaterThanOrEqual(2);
    expect(tracks.some((t) => t.kind === 'audio')).toBe(true);
  });

  it('migrates legacy base clips to main video track with sequential start times', () => {
    const clips = [makeClip('a', 5), makeClip('b', 3)];
    const tracks = migrateLegacyClipsToTracks(clips, []);
    const main = tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID);
    expect(main?.items).toHaveLength(2);
    expect(main?.items[0]).toEqual({ clipId: 'a', startTime: 0 });
    expect(main?.items[1]).toEqual({ clipId: 'b', startTime: 5 });
  });

  it('migrates PiP overlays to overlay video track', () => {
    const clips = [
      makeClip('base', 5),
      makeClip('pip', 4, { layerIndex: 1, x: 10, y: 10 }),
    ];
    const tracks = migrateLegacyClipsToTracks(clips, []);
    const overlay = tracks.find((t) => t.id === OVERLAY_VIDEO_TRACK_ID);
    expect(overlay?.items).toHaveLength(1);
    expect(overlay?.items[0].clipId).toBe('pip');
    expect(overlay?.items[0].startTime).toBe(0);
  });

  it('toLegacyTimelineView preserves layerIndex semantics', () => {
    const clips = [
      makeClip('base', 5),
      makeClip('pip', 4, { layerIndex: 1 }),
    ];
    const tracks = migrateLegacyClipsToTracks(clips, []);
    const legacy = toLegacyTimelineView(tracks, clips);
    expect(legacy.map((c) => c.id)).toEqual(['base', 'pip']);
    expect(legacy[0].layerIndex ?? 0).toBe(0);
    expect(legacy[1].layerIndex).toBe(1);
  });
});

describe('project migration', () => {
  it('serializeProject emits schemaVersion and tracks', () => {
    const clips = [makeClip('a', 5)];
    const tracks = migrateLegacyClipsToTracks(clips, []);
    const project = serializeProject(clips, [], [], [], undefined, tracks);
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(project.tracks?.length).toBeGreaterThan(0);
  });

  it('applyProjectData migrates legacy projects without tracks', async () => {
    const legacy = {
      clips: [
        {
          id: 'a',
          title: 'a',
          kind: 'video' as const,
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          videoFadeIn: 0,
          videoFadeOut: 0,
          audioFadeIn: 0,
          audioFadeOut: 0,
          fileName: 'a.mp4',
        },
      ],
    };
    const live = makeClip('a', 5);
    const result = await applyProjectData(legacy, [live]);
    expect(result.tracks.length).toBeGreaterThan(0);
    expect(result.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)?.items).toHaveLength(1);
  });

  it('applyProjectData round-trips v1 track placements', async () => {
    const clips = [makeClip('a', 5), makeClip('b', 3)];
    const transitions: ClipTransition[] = [];
    const tracks = migrateLegacyClipsToTracks(clips, transitions);
    const project = serializeProject(clips, transitions, [], [], undefined, tracks);
    const result = await applyProjectData(project, clips);
    expect(result.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)?.items.map((i) => i.clipId)).toEqual([
      'a',
      'b',
    ]);
  });
});
