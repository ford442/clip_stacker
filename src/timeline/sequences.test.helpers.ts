import type { Clip, TextOverlay, Track } from '../types';
import { createDefaultTracks, MAIN_VIDEO_TRACK_ID, OVERLAY_VIDEO_TRACK_ID } from './trackBasics';
import { normalizeBaseLane } from './editModeCore';
import type { SequenceEditorState } from './sequenceModel';

export function seqTestClip(id: string, duration: number, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    file: new File(['x'], `${id}.mp4`, { type: 'video/mp4' }),
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

export function seqTestOverlay(id: string, overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id,
    text: id,
    fontsize: 40,
    fontcolor: 'white',
    x: 0.1,
    y: 0.1,
    scrolling: false,
    scrollSpeed: 20,
    box: false,
    boxColor: 'black@0.5',
    ...overrides,
  };
}

/**
 * A root timeline: `base` clips on the main lane in order, `overlays` as
 * `[clip, startTime]` on the second video lane, `titles` unplaced.
 */
export function seqTestState(
  base: Clip[],
  overlays: Array<[Clip, number]> = [],
  titles: TextOverlay[] = [],
): SequenceEditorState {
  const clips = [...base, ...overlays.map(([clip]) => clip)];
  const tracks: Track[] = createDefaultTracks().map((track) =>
    track.id === MAIN_VIDEO_TRACK_ID
      ? { ...track, items: base.map((clip, i) => ({ clipId: clip.id, startTime: i * 1000 })) }
      : track.id === OVERLAY_VIDEO_TRACK_ID
        ? { ...track, items: overlays.map(([clip, startTime]) => ({ clipId: clip.id, startTime })) }
        : track,
  );
  return {
    tracks: normalizeBaseLane(tracks, clips, []),
    clips,
    clipGroups: [],
    transitions: [],
    textOverlays: titles,
    sequences: [],
    sequencePath: [],
    rootStash: null,
  };
}

/** Unwrap an edit result, failing the test with its reason. */
export function expectOk<T extends { ok: true; state: SequenceEditorState } | { ok: false; reason: string }>(
  result: T,
): SequenceEditorState {
  if (!result.ok) throw new Error(`edit refused: ${result.reason}`);
  return result.state;
}
