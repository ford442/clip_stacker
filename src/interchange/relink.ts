/**
 * Media relinking for imported timelines (and *Relink media…*): which
 * available file each clip's media reference resolves to.
 *
 * Pure matching; the caller gathers candidates (library clips, picked files,
 * Drive library items), computes content hashes only when a reference has
 * one and its name did not match (`needsHashes`), and does the I/O. Order:
 * exact file name, then the name ignoring case, then `fingerprintMedia` hash,
 * then Drive file id (or a Drive item of the same name). Anything left is an
 * offline clip.
 */

import type { MediaReference } from './model';

export type RelinkSource = 'library' | 'file' | 'drive';

export interface RelinkCandidate {
  /** Caller's key for the candidate (a clip id, a file index, a Drive id). */
  key: string;
  source: RelinkSource;
  name: string;
  hash?: string;
  driveId?: string;
}

export interface RelinkRequest {
  clipId: string;
  reference: Pick<MediaReference, 'name' | 'hash' | 'driveId'>;
}

export type RelinkMatchKind = 'name' | 'name-ignoring-case' | 'hash' | 'drive';

export interface RelinkMatch {
  clipId: string;
  candidate: RelinkCandidate;
  by: RelinkMatchKind;
}

export interface RelinkPlan {
  matches: RelinkMatch[];
  /** Clip ids nothing matched: they import (or stay) offline. */
  unresolved: string[];
}

const SOURCE_RANK: Record<RelinkSource, number> = { library: 0, file: 1, drive: 2 };

function best<T extends RelinkCandidate>(found: T[]): T | undefined {
  return [...found].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0];
}

/** Base name of a path or URL (`media/a b.mp4` → `a b.mp4`). */
export function baseName(name: string): string {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? name;
}

/** True when an unmatched request carries a hash, so hashing candidates could still help. */
export function needsHashes(requests: RelinkRequest[], candidates: RelinkCandidate[]): boolean {
  const plan = planRelink(requests, candidates);
  const byId = new Map(requests.map((r) => [r.clipId, r]));
  return plan.unresolved.some((id) => Boolean(byId.get(id)?.reference.hash));
}

/** Resolve each request against the candidates (no candidate is required to be unique). */
export function planRelink(requests: RelinkRequest[], candidates: RelinkCandidate[]): RelinkPlan {
  const byName = new Map<string, RelinkCandidate[]>();
  const byLower = new Map<string, RelinkCandidate[]>();
  const byHash = new Map<string, RelinkCandidate[]>();
  const byDrive = new Map<string, RelinkCandidate[]>();
  const push = (map: Map<string, RelinkCandidate[]>, key: string | undefined, candidate: RelinkCandidate) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(candidate);
    else map.set(key, [candidate]);
  };
  for (const candidate of candidates) {
    const name = baseName(candidate.name);
    push(byName, name, candidate);
    push(byLower, name.toLowerCase(), candidate);
    push(byHash, candidate.hash?.toLowerCase(), candidate);
    push(byDrive, candidate.driveId, candidate);
  }
  const matches: RelinkMatch[] = [];
  const unresolved: string[] = [];
  for (const { clipId, reference } of requests) {
    const name = baseName(reference.name);
    const attempts: Array<[RelinkMatchKind, RelinkCandidate | undefined]> = [
      ['name', best(byName.get(name) ?? [])],
      ['name-ignoring-case', best(byLower.get(name.toLowerCase()) ?? [])],
      ['hash', reference.hash ? best(byHash.get(reference.hash.toLowerCase()) ?? []) : undefined],
      ['drive', reference.driveId ? best(byDrive.get(reference.driveId) ?? []) : undefined],
    ];
    const hit = attempts.find(([, candidate]) => candidate !== undefined);
    if (hit?.[1]) matches.push({ clipId, candidate: hit[1], by: hit[0] });
    else unresolved.push(clipId);
  }
  return { matches, unresolved };
}
