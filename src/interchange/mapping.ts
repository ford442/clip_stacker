/**
 * The interchange mapping, in one table.
 *
 * `toInterchange.ts` (project → neutral timeline) and `fromInterchange.ts`
 * (neutral timeline → project) implement these rows, and `otio.ts`,
 * `fcpxml.ts` and `edl.ts` only spell the neutral model in their own syntax.
 * A row changes here, in the two mapping modules, and nowhere per format.
 * `docs/interchange.md` renders this table; `mapping.test.ts` checks every
 * concept still has a row.
 */

import type { MetaBag } from './model';

export type InterchangeFormat = 'otio' | 'fcpxml' | 'edl';

export interface MappingRow {
  concept: string;
  otio: string;
  fcpxml: string;
  edl: string;
  /** What the neutral model calls it / how the importer resolves it. */
  note: string;
}

export const INTERCHANGE_MAPPING: readonly MappingRow[] = [
  {
    concept: 'Main video lane',
    otio: 'first video Track',
    fcpxml: 'primary spine',
    edl: 'V events',
    note: 'role `base`; its record positions come from transition-aware segment maths',
  },
  {
    concept: 'Overlay video lanes',
    otio: 'further video Tracks (bottom to top)',
    fcpxml: 'connected clips, lane 1…n',
    edl: 'not written (one video track); listed as comments',
    note: 'role `overlay`; overlapping items spill into extra tracks tagged with the same lane id',
  },
  {
    concept: 'Audio lanes',
    otio: 'audio Tracks',
    fcpxml: 'connected clips, lane −1…−n',
    edl: 'A / A2 events for audio clips on the first two audio lanes',
    note: 'role `audio`',
  },
  {
    concept: 'Titles lanes / text overlays',
    otio: 'video Track of Clips with a `GeneratorReference` (`clip_stacker.title`)',
    fcpxml: '`title` (Basic Title) connected above the overlays',
    edl: 'not written',
    note: 'role `titles`; a title runs from its placement to the end of the programme',
  },
  {
    concept: 'Lane mute',
    otio: 'Track `enabled: false`',
    fcpxml: '`enabled="0"` on the lane\'s clips',
    edl: 'muted lanes are skipped',
    note: 'lane `muted`',
  },
  {
    concept: 'Clip trim',
    otio: '`source_range` (media time at the sequence rate)',
    fcpxml: '`start` / `duration`',
    edl: 'source in / out',
    note: '`sourceIn` + `duration`; exact seconds ride in metadata while they agree to a frame',
  },
  {
    concept: 'Constant speed',
    otio: '`LinearTimeWarp.time_scalar`',
    fcpxml: '`timeMap` (two points)',
    edl: '`M2` (reel, fps, source in)',
    note: '`speed`; reversed clips have a negative speed',
  },
  {
    concept: 'Speed curve (`automation.playbackRate`)',
    otio: 'sampled points in metadata (`LinearTimeWarp` carries the average)',
    fcpxml: '`timeMap` sampled at every keyframe and each second',
    edl: '`M2` at the average speed',
    note: '`timeMap`',
  },
  {
    concept: 'Base-lane transition',
    otio: '`Transition` with `in_offset` = `out_offset` = half the duration',
    fcpxml: '`transition` centred on the edit',
    edl: '`D` dissolve starting at the edit, length in frames',
    note: 'the transition id survives in metadata; an unknown id imports as `dissolve`',
  },
  {
    concept: 'Volume / pan automation',
    otio: 'metadata only (OTIO has no audio-effect schema)',
    fcpxml: '`adjust-volume` + `keyframeAnimation` (dB)',
    edl: 'not written',
    note: '`volume`; pan rides in metadata',
  },
  {
    concept: 'Captions',
    otio: 'timeline `Marker`s, colour `PURPLE`, `clip_stacker.caption`',
    fcpxml: '`caption` (ITT) on its own lane',
    edl: 'not written',
    note: '`captions`',
  },
  {
    concept: 'Markers (master-track markers)',
    otio: 'timeline `Marker`s',
    fcpxml: '`marker` on the spine element under it',
    edl: '`* LOC:` comments',
    note: '`markers`',
  },
  {
    concept: 'Nested sequence',
    otio: '`Stack` with a `source_range`',
    fcpxml: '`media` compound clip + `ref-clip`',
    edl: 'flattened to one event named after the sequence',
    note: 'role-preserving: the stack\'s tracks are the sequence\'s lanes',
  },
  {
    concept: 'Media',
    otio: '`ExternalReference.target_url` + `available_range`',
    fcpxml: '`asset` + `media-rep`',
    edl: '`* FROM CLIP NAME:` / `* SOURCE FILE:` comments, reel = name',
    note: 'relinked by file name, then content hash, then Drive id; otherwise an offline clip',
  },
  {
    concept: 'Everything else (finishing, bus FX, keys, picture transform, stabilize, proxies, ids)',
    otio: '`metadata.clip_stacker`',
    fcpxml: '`metadata` / `md key="com.clipstacker.*"` (JSON)',
    edl: 'not written',
    note: 'so export → import → export is byte-identical',
  },
  {
    concept: 'Timecode start / rate',
    otio: '`global_start_time` (`RationalTime` at the sequence rate)',
    fcpxml: 'sequence `tcStart` / `tcFormat`, format `frameDuration`',
    edl: 'record timecodes, `FCM: DROP FRAME` / `NON-DROP FRAME`',
    note: '`Project.timecodeStart` / `timecodeRate` (default 01:00:00:00 at 30)',
  },
];

/** The FCPXML `md` key prefix for Clip Stacker metadata. */
export const FCPXML_META_PREFIX = 'com.clipstacker.';

/** Read a namespaced metadata value (`meta[key]`) as an object, or null. */
export function metaObject(meta: MetaBag | undefined, key: string): Record<string, unknown> | null {
  const value = meta?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A finite number from metadata, or null. */
export function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The exact value metadata carries, while it still agrees with what the
 * file says to within `tolerance` seconds (a frame, or a few for values
 * derived through a speed); otherwise the file's — a foreign edit wins.
 */
export function agreeing(exact: number | null, fromFile: number, tolerance: number): number {
  return exact !== null && Math.abs(exact - fromFile) <= tolerance + 1e-9 ? exact : fromFile;
}

/** JSON with sorted keys, so metadata written twice is written identically. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** `T` with every property that may be `undefined` made optional instead. */
export type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop undefined fields (metadata never carries them, so a round trip cannot add them). */
export function compact<T extends object>(value: T): Compact<T> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return out as Compact<T>;
}
