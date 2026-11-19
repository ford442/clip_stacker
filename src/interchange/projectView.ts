/**
 * A saved project (`Project`, the JSON a save writes) read back as timeline
 * bodies without touching media: clips get a placeholder `File`, so the
 * timeline maths (`getClipDuration`, segment scheduling, A/B resolution) runs
 * on them unchanged. The interchange exporter works from this view so that
 * the app, a test and a headless caller all export the same JSON the same way.
 */

import type {
  Clip,
  ClipGroup,
  ClipTransition,
  Project,
  SerializedClip,
  SerializedSequence,
  SerializedTrack,
  SerializedTransition,
  TextOverlay,
  Track,
} from '../types';
import { migrateLegacyClipsToTracks } from '../timeline/trackModel';

/** One timeline's contents: the root, or a nested sequence. */
export interface ProjectBodyView {
  clips: Clip[];
  tracks: Track[];
  groups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
}

export interface ProjectView {
  root: ProjectBodyView;
  sequences: Map<string, { id: string; name: string; body: ProjectBodyView }>;
  /** The saved clip behind each pseudo clip, by id. */
  saved: Map<string, SerializedClip>;
}

/** A clip as the timeline maths needs it; its media is a name only. */
export function pseudoClip(saved: SerializedClip): Clip {
  const { trimEnd, ...rest } = saved;
  const file = new File([], saved.fileName || saved.title || 'media', saved.fileType ? { type: saved.fileType } : {});
  return {
    ...(rest as Omit<SerializedClip, 'trimEnd'>),
    file,
    objectUrl: '',
    trimEnd: trimEnd == null ? NaN : Number(trimEnd),
  } as Clip;
}

function readTracks(raw: SerializedTrack[] | undefined): Track[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((track) => ({ ...track, items: track.items.map((item) => ({ ...item })) }));
}

export function readTransitions(raw: SerializedTransition[] | undefined): ClipTransition[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const transition: ClipTransition = { afterClipIndex: Number(t.afterClipIndex), type: t.type, duration: Number(t.duration) };
    if (t.params) transition.params = { ...t.params };
    if (t.customShader) transition.customShader = t.customShader;
    if (t.morphSegment) {
      transition.morphSegment = {
        objectUrl: '',
        fileName: t.morphSegment.fileName,
        duration: t.morphSegment.duration,
        status: t.morphSegment.status,
        ...(t.morphSegment.error ? { error: t.morphSegment.error } : {}),
      };
    }
    return transition;
  });
}

function groupsFor(clips: Clip[], project: Project): ClipGroup[] {
  const active = new Map((project.clipGroups ?? []).map((group) => [group.id, group.activeVariant]));
  const groups = new Map<string, ClipGroup>();
  for (const clip of clips) {
    if (!clip.groupId || !clip.groupVariant) continue;
    let group = groups.get(clip.groupId);
    if (!group) {
      group = { id: clip.groupId, variants: { A: null, B: null }, activeVariant: active.get(clip.groupId) ?? 'A' };
      groups.set(clip.groupId, group);
    }
    group.variants[clip.groupVariant] = clip;
  }
  return [...groups.values()];
}

function bodyOf(
  clips: Clip[],
  tracks: SerializedTrack[] | undefined,
  transitions: SerializedTransition[] | undefined,
  textOverlays: TextOverlay[] | undefined,
  project: Project,
): ProjectBodyView {
  const groups = groupsFor(clips, project);
  const parsedTransitions = readTransitions(transitions);
  return {
    clips,
    groups,
    transitions: parsedTransitions,
    textOverlays: (textOverlays ?? []).map((overlay) => ({ ...overlay })),
    tracks: readTracks(tracks) ?? migrateLegacyClipsToTracks(clips, parsedTransitions, groups),
  };
}

/** The saved project as bodies of pseudo clips (root first, then each sequence). */
export function projectView(project: Project): ProjectView {
  const saved = new Map(project.clips.map((clip) => [clip.id, clip]));
  const sequences = (project.sequences ?? []) as SerializedSequence[];
  const claimed = new Set(sequences.flatMap((seq) => seq.clipIds));
  const pseudo = new Map(project.clips.map((clip) => [clip.id, pseudoClip(clip)]));
  const rootClips = project.clips.filter((clip) => !claimed.has(clip.id)).map((clip) => pseudo.get(clip.id)!);
  const view: ProjectView = {
    root: bodyOf(rootClips, project.tracks, project.transitions, project.textOverlays, project),
    sequences: new Map(),
    saved,
  };
  for (const seq of sequences) {
    const clips = seq.clipIds.map((id) => pseudo.get(id)).filter((clip): clip is Clip => Boolean(clip));
    view.sequences.set(seq.id, {
      id: seq.id,
      name: seq.name,
      body: bodyOf(clips, seq.tracks, seq.transitions, seq.textOverlays, project),
    });
  }
  return view;
}
