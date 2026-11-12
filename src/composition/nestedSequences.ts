import type { Clip, NestedSequenceContent, SequenceBody, TextOverlay } from '../types';
import { getEffectiveTimelineClips, visibleTextOverlays } from '../timeline/trackModel';
import {
  NESTED_SEQUENCE_MAX_DEPTH,
  isSequenceClip,
  nestedInstanceId,
  sequenceIdOf,
} from '../timeline/sequenceResolve';
import { timelinePlanDuration } from './previewComposition';

/**
 * Nested sequences, resolved for playback.
 *
 * {@link resolveNestedSequences} turns the sequence graph into data on the
 * flattened timeline view: each sequence clip gets `nested` — the sequence's
 * own flattened clips (nested again), transitions, visible titles and lanes.
 * Nothing downstream is handed the graph: the composition plan, the audio
 * schedule and the compositors recurse on `clip.nested`, and the worker
 * receives it with the clips it already posts.
 */

/** Sequence bodies by id (the editor's committed view, see `sequenceModel.ts`). */
export type SequenceBodies = ReadonlyMap<string, SequenceBody>;

/** Per body: the resolved content, valid for the lookup and ancestry it was built with. */
const contentCache = new WeakMap<
  SequenceBody,
  { bodies: SequenceBodies; ancestry: string; content: NestedSequenceContent }
>();

function resolveContent(
  sequenceId: string,
  body: SequenceBody,
  bodies: SequenceBodies,
  ancestors: string[],
): NestedSequenceContent {
  const ancestry = ancestors.join('\u0000');
  const cached = contentCache.get(body);
  if (cached && cached.bodies === bodies && cached.ancestry === ancestry) return cached.content;

  const flat = getEffectiveTimelineClips(body.tracks, body.clips, body.clipGroups);
  const clips = stampNested(flat, bodies, ancestors);
  const content: NestedSequenceContent = {
    sequenceId,
    clips,
    transitions: body.transitions,
    textOverlays: visibleTextOverlays(body.tracks, body.textOverlays),
    tracks: body.tracks,
    duration: timelinePlanDuration(clips, body.transitions),
  };
  contentCache.set(body, { bodies, ancestry, content });
  return content;
}

function stampNested(clips: Clip[], bodies: SequenceBodies, ancestors: string[]): Clip[] {
  if (!clips.some((clip) => isSequenceClip(clip) || clip.nested)) return clips;
  let changed = false;
  const next = clips.map((clip) => {
    const id = sequenceIdOf(clip);
    const body = id ? bodies.get(id) : undefined;
    // An unknown sequence, a cycle or too deep: the clip resolves to nothing.
    const resolvable =
      id !== null &&
      body !== undefined &&
      !ancestors.includes(id) &&
      ancestors.length < NESTED_SEQUENCE_MAX_DEPTH;
    if (!resolvable) {
      if (!clip.nested) return clip;
      changed = true;
      const { nested: _dropped, ...rest } = clip;
      return rest;
    }
    const content = resolveContent(id, body, bodies, [...ancestors, id]);
    if (clip.nested === content) return clip;
    changed = true;
    return { ...clip, nested: content };
  });
  return changed ? next : clips;
}

/**
 * Stamp `nested` onto every sequence clip of a flattened timeline view.
 * `rootSequenceId` is the sequence the view belongs to (null = the root),
 * so a sequence that somehow contains itself resolves to nothing instead of
 * recursing. Returns `timelineClips` itself when it has no sequence clips.
 */
export function resolveNestedSequences(
  timelineClips: Clip[],
  bodies: SequenceBodies,
  rootSequenceId: string | null = null,
): Clip[] {
  return stampNested(timelineClips, bodies, rootSequenceId ? [rootSequenceId] : []);
}

const instanceCache = new WeakMap<Clip[], Clip[]>();

/**
 * `clips` plus one instance per clip inside every nested sequence, under
 * the namespaced id the composition plan gives its layers
 * (`nestedInstanceId`). Compositors look layer clips up in this list, and
 * the preview worker is sent media for these ids, so the same source shown
 * through two sequence clips decodes as two layers. Returns `clips` itself
 * when nothing is nested.
 */
export function withNestedInstances(clips: Clip[]): Clip[] {
  if (!clips.some((clip) => clip.nested)) return clips;
  const cached = instanceCache.get(clips);
  if (cached) return cached;
  const out = [...clips];
  const visit = (list: Clip[], prefix: string, depth: number) => {
    if (depth > NESTED_SEQUENCE_MAX_DEPTH) return;
    for (const inner of list) {
      const id = nestedInstanceId(prefix, inner.id);
      const { nested, ...rest } = inner;
      out.push({ ...rest, id });
      if (nested) visit(nested.clips, id, depth + 1);
    }
  };
  for (const clip of clips) {
    if (clip.nested) visit(clip.nested.clips, clip.id, 1);
  }
  instanceCache.set(clips, out);
  return out;
}

/**
 * Every title drawn inside the nested sequences of `clips` (recursively).
 * Export gates — "is there a text pass?", HDR10 graphics routing — must see
 * these too; they are drawn by the plan, never passed as root overlays.
 */
export function nestedTextOverlays(clips: Clip[]): TextOverlay[] {
  const out: TextOverlay[] = [];
  const visit = (list: Clip[], depth: number) => {
    if (depth > NESTED_SEQUENCE_MAX_DEPTH) return;
    for (const clip of list) {
      if (!clip.nested) continue;
      out.push(...clip.nested.textOverlays);
      visit(clip.nested.clips, depth + 1);
    }
  };
  visit(clips, 1);
  return out;
}

/** Root titles plus every nested sequence's — what an export draws. */
export function effectiveTextOverlays(clips: Clip[], textOverlays: TextOverlay[]): TextOverlay[] {
  const nested = nestedTextOverlays(clips);
  return nested.length === 0 ? textOverlays : [...textOverlays, ...nested];
}
