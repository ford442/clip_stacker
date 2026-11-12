import type { Clip, Sequence, SequenceBody } from '../types';

/**
 * Nested-sequence identity, time mapping and the cycle check.
 *
 * A leaf module (types only), so the composition planner, the audio
 * schedule and the edit model can all import it without a cycle.
 */

/**
 * Deepest nesting the planner and the audio schedule follow. Deeper
 * references resolve to nothing (black, silent) rather than recursing on.
 */
export const NESTED_SEQUENCE_MAX_DEPTH = 8;

/**
 * Joins a sequence clip's id to the id of a clip inside it. Must not occur
 * in a clip id, and must not be `::` — decoder-cursor keys split on that.
 */
export const NESTED_ID_SEPARATOR = '>';

/** True when the clip plays a nested sequence rather than a file. */
export function isSequenceClip(clip: Pick<Clip, 'source'>): boolean {
  return clip.source?.type === 'sequence';
}

/** The sequence a clip plays, or null for a media clip. */
export function sequenceIdOf(clip: Pick<Clip, 'source'>): string | null {
  return clip.source?.type === 'sequence' ? clip.source.sequenceId : null;
}

/**
 * Id of one placement of `innerId` inside the sequence clip `parentId`.
 *
 * The same pool clip shown through two sequence clips (or twice at different
 * depths) gets two ids, so every per-clip cache — media elements, decoder
 * cursors, decoded audio — keeps one entry per *instance*: nested layers are
 * more layers, not more files.
 */
export function nestedInstanceId(parentId: string, innerId: string): string {
  return `${parentId}${NESTED_ID_SEPARATOR}${innerId}`;
}

/** Sequence ids the clips of `body` play (each once, in clip order). */
export function sequenceReferences(body: Pick<SequenceBody, 'clips'>): string[] {
  const ids: string[] = [];
  for (const clip of body.clips) {
    const id = sequenceIdOf(clip);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Every sequence reachable from `startId` through sequence clips, `startId`
 * included. Unknown ids are skipped.
 */
export function sequencesReachableFrom(
  sequences: ReadonlyArray<Pick<Sequence, 'id' | 'clips'>>,
  startId: string,
): Set<string> {
  const byId = new Map(sequences.map((seq) => [seq.id, seq]));
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const seq = byId.get(id);
    if (seq) stack.push(...sequenceReferences(seq));
  }
  return seen;
}

/**
 * Whether placing `candidateId` inside the sequence `hostId` would make a
 * cycle: the candidate is the host, or the host is reachable from it (A
 * contains B contains A). `hostId` null is the root, which nothing can
 * contain, so it never cycles.
 */
export function sequenceWouldCycle(
  sequences: ReadonlyArray<Pick<Sequence, 'id' | 'clips'>>,
  hostId: string | null,
  candidateId: string,
): boolean {
  if (hostId === null) return false;
  return sequencesReachableFrom(sequences, candidateId).has(hostId);
}

/**
 * The clip fields a sequence clip cannot honour, reset. Its picture is a
 * whole timeline: speed, reverse, loops and stabilization would have to be
 * applied to every layer and every audio entry inside it, so they are not
 * offered rather than half-applied. Fades, opacity, volume, position and
 * size do apply. Returns the same object when nothing changes.
 */
export function sanitizeSequenceClip(clip: Clip): Clip {
  if (!isSequenceClip(clip)) return clip;
  const transformLanes = clip.keyframes
    ? PICTURE_TRANSFORM_LANES.filter((lane) => clip.keyframes?.[lane] !== undefined)
    : [];
  const unsupported =
    transformLanes.length > 0 ||
    (clip.playbackRate != null && clip.playbackRate !== 1) ||
    clip.reversed ||
    (clip.loopCount != null && clip.loopCount !== 1) ||
    (clip.automation?.playbackRate?.length ?? 0) > 0 ||
    clip.stabilize ||
    clip.stabilization ||
    clip.overlayBlend ||
    clip.chromaKey ||
    clip.stillImage ||
    clip.proxy;
  if (!unsupported) return clip;
  const {
    playbackRate: _rate,
    reversed: _reversed,
    loopCount: _loops,
    stabilize: _stabilize,
    stabilization: _stabilization,
    overlayBlend: _blend,
    chromaKey: _key,
    stillImage: _still,
    proxy: _proxy,
    ...rest
  } = clip;
  const next: Clip = rest;
  if (clip.automation?.playbackRate) {
    const { playbackRate: _curve, ...automation } = clip.automation;
    if (Object.keys(automation).length > 0) next.automation = automation;
    else delete next.automation;
  }
  if (transformLanes.length > 0 && clip.keyframes) {
    const keyframes = { ...clip.keyframes };
    for (const lane of transformLanes) delete keyframes[lane];
    if (Object.keys(keyframes).length > 0) next.keyframes = keyframes;
    else delete next.keyframes;
  }
  return next;
}

/** Picture-transform keyframe lanes (rotation / scale / anchor) — not applied to a sequence clip. */
const PICTURE_TRANSFORM_LANES = ['rotation', 'scaleX', 'scaleY', 'anchorX', 'anchorY'] as const;
