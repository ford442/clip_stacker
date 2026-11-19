/**
 * OpenTimelineIO (`.otio`, JSON) ↔ the neutral timeline (`model.ts`).
 *
 * Writes `Timeline.1` → `Stack.1` → `Track.1` of `Clip.2` / `Gap.1` /
 * `Transition.1` / nested `Stack.1`, with `ExternalReference.1` media and
 * `RationalTime.1` values that are whole frames at the sequence rate. Reads
 * the same schemas plus the older `Clip.1` (`media_reference`) and
 * `Marker.1`, and rescales times written at other rates. Titles are clips
 * with a `GeneratorReference.1` of kind `clip_stacker.title`; captions and
 * timeline markers are markers on the top-level stack.
 */

import {
  CLIP_STACKER_NAMESPACE,
  type InterchangeCaption,
  type InterchangeItem,
  type InterchangeMarker,
  type InterchangeTimeline,
  type InterchangeTrack,
  type MediaReference,
  type MetaBag,
} from './model';
import { rateToNumber, rescaleFrames, type FrameRate } from './rational';
import { timecodeRate, timecodeRateForFps, isTimecodeRateId, type TimecodeRate } from './timecode';
import { compact, metaObject, sortKeys } from './mapping';

const TITLE_GENERATOR = 'clip_stacker.title';
const CAPTION_COLOR = 'PURPLE';
const MARKER_COLOR = 'RED';

type Json = Record<string, unknown>;

function rationalTime(frames: number, rate: number): Json {
  return { OTIO_SCHEMA: 'RationalTime.1', rate, value: frames };
}

function timeRange(start: number, duration: number, rate: number): Json {
  return { OTIO_SCHEMA: 'TimeRange.1', duration: rationalTime(duration, rate), start_time: rationalTime(start, rate) };
}

function metadata(meta: MetaBag | undefined): Json {
  return meta && Object.keys(meta).length > 0 ? { [CLIP_STACKER_NAMESPACE]: sortKeys(meta) } : {};
}

/** A relative file name as a URL path (spaces and `#` escaped). */
function targetUrl(media: MediaReference): string {
  return media.url ?? encodeURI(media.name).replace(/#/g, '%23');
}

function mediaReference(media: MediaReference, rate: number): Json {
  return {
    OTIO_SCHEMA: 'ExternalReference.1',
    available_image_bounds: null,
    available_range: media.availableFrames !== undefined ? timeRange(0, media.availableFrames, rate) : null,
    metadata: metadata(
      compact({
        media: compact({
          name: media.name,
          hasVideo: media.hasVideo,
          hasAudio: media.hasAudio,
          width: media.width,
          height: media.height,
          hash: media.hash,
          driveId: media.driveId,
        }),
      }),
    ),
    name: media.name,
    target_url: targetUrl(media),
  };
}

function itemJson(item: InterchangeItem, rate: number): Json {
  switch (item.type) {
    case 'gap':
      return {
        OTIO_SCHEMA: 'Gap.1',
        effects: [],
        enabled: true,
        markers: [],
        metadata: {},
        name: '',
        source_range: timeRange(0, item.duration, rate),
      };
    case 'transition':
      return {
        OTIO_SCHEMA: 'Transition.1',
        in_offset: rationalTime(item.inOffset, rate),
        metadata: metadata(item.meta),
        name: item.name,
        out_offset: rationalTime(item.outOffset, rate),
        transition_type: item.name === 'dissolve' || item.name === 'fade' ? 'SMPTE_Dissolve' : 'Custom_Transition',
      };
    case 'title':
      return {
        OTIO_SCHEMA: 'Clip.2',
        active_media_reference_key: 'DEFAULT_MEDIA',
        effects: [],
        enabled: item.enabled,
        markers: [],
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: 'GeneratorReference.1',
            available_image_bounds: null,
            available_range: null,
            generator_kind: TITLE_GENERATOR,
            metadata: {},
            name: '',
            parameters: { text: item.text },
          },
        },
        metadata: metadata(item.meta),
        name: item.text,
        source_range: timeRange(0, item.duration, rate),
      };
    case 'stack':
      return {
        OTIO_SCHEMA: 'Stack.1',
        children: item.tracks.map((track) => trackJson(track, rate)),
        effects: [],
        enabled: item.enabled,
        markers: [],
        metadata: metadata(item.meta),
        name: item.name,
        source_range: timeRange(item.sourceIn, item.duration, rate),
      };
    case 'clip': {
      const meta: MetaBag = { ...(item.meta ?? {}) };
      if (item.timeMap) meta['timeMap'] = item.timeMap;
      if (item.volume) meta['volume'] = item.volume;
      return {
        OTIO_SCHEMA: 'Clip.2',
        active_media_reference_key: 'DEFAULT_MEDIA',
        effects:
          item.speed !== 1
            ? [{ OTIO_SCHEMA: 'LinearTimeWarp.1', effect_name: 'LinearTimeWarp', metadata: {}, name: '', time_scalar: item.speed }]
            : [],
        enabled: item.enabled,
        markers: [],
        media_references: { DEFAULT_MEDIA: mediaReference(item.media, rate) },
        metadata: metadata(meta),
        name: item.name,
        source_range: timeRange(item.sourceIn, item.duration, rate),
      };
    }
  }
}

function trackJson(track: InterchangeTrack, rate: number): Json {
  return {
    OTIO_SCHEMA: 'Track.1',
    children: track.items.map((item) => itemJson(item, rate)),
    effects: [],
    enabled: track.enabled,
    kind: track.kind === 'audio' ? 'Audio' : 'Video',
    markers: [],
    metadata: metadata(compact({ ...(track.meta ?? {}), role: track.role })),
    name: track.name,
    source_range: null,
  };
}

function markerJson(marker: InterchangeMarker | InterchangeCaption, rate: number, color: string, name: string): Json {
  return {
    OTIO_SCHEMA: 'Marker.2',
    color,
    comment: '',
    marked_range: timeRange(marker.frame, marker.duration, rate),
    metadata: metadata(marker.meta),
    name,
  };
}

/** The neutral timeline as OTIO JSON (4-space indent, as `otiotool` writes). */
export function writeOtio(timeline: InterchangeTimeline): string {
  const rate = rateToNumber(timeline.rate);
  const markers = [
    ...timeline.markers.map((m) => markerJson(m, rate, MARKER_COLOR, m.name)),
    ...timeline.captions.map((c) => markerJson(c, rate, CAPTION_COLOR, c.text)),
  ];
  const doc = {
    OTIO_SCHEMA: 'Timeline.1',
    global_start_time: rationalTime(timeline.startFrame, rate),
    metadata: metadata(
      compact({
        ...(timeline.meta ?? {}),
        format: { width: timeline.width, height: timeline.height, rate: timeline.rate.id },
      }),
    ),
    name: timeline.name,
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: timeline.tracks.map((track) => trackJson(track, rate)),
      effects: [],
      enabled: true,
      markers,
      metadata: {},
      name: 'tracks',
      source_range: null,
    },
  };
  return `${JSON.stringify(doc, null, 4)}\n`;
}

// ---------------------------------------------------------------------------
// Reading

class OtioError extends Error {
  override name = 'OtioError';
}

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function schemaOf(node: unknown): string {
  return isObject(node) && typeof node['OTIO_SCHEMA'] === 'string' ? node['OTIO_SCHEMA'].replace(/\.\d+$/, '') : '';
}

function ourMeta(node: Json): MetaBag | undefined {
  const meta = isObject(node['metadata']) ? node['metadata'][CLIP_STACKER_NAMESPACE] : undefined;
  return isObject(meta) ? (meta as MetaBag) : undefined;
}

interface ReadCtx {
  rate: FrameRate;
}

function readTime(node: unknown, ctx: ReadCtx): number {
  if (!isObject(node)) return 0;
  const value = Number(node['value']);
  const rate = Number(node['rate']);
  if (!Number.isFinite(value)) return 0;
  if (!(rate > 0) || Math.abs(rate - rateToNumber(ctx.rate)) < 1e-6) return Math.round(value);
  return rescaleFrames(value, rate, ctx.rate);
}

function readRange(node: unknown, ctx: ReadCtx): { start: number; duration: number } | null {
  if (!isObject(node)) return null;
  return { start: readTime(node['start_time'], ctx), duration: readTime(node['duration'], ctx) };
}

function readMedia(clip: Json): Json | null {
  if (isObject(clip['media_references'])) {
    const key = typeof clip['active_media_reference_key'] === 'string' ? clip['active_media_reference_key'] : 'DEFAULT_MEDIA';
    const ref = clip['media_references'][key] ?? Object.values(clip['media_references'])[0];
    return isObject(ref) ? ref : null;
  }
  return isObject(clip['media_reference']) ? clip['media_reference'] : null;
}

function fileNameOf(url: string, fallback: string): string {
  const path = url.replace(/^[a-z]+:\/\/[^/]*/i, '').split(/[?#]/)[0] ?? '';
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  if (!last) return fallback;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function readMediaReference(ref: Json | null, clipName: string, ctx: ReadCtx): MediaReference {
  const meta = ref ? metaObject(ourMeta(ref), 'media') : null;
  const url = ref && typeof ref['target_url'] === 'string' ? ref['target_url'] : undefined;
  const refName = ref && typeof ref['name'] === 'string' && ref['name'] ? ref['name'] : undefined;
  const name = typeof meta?.['name'] === 'string' ? meta['name'] : url ? fileNameOf(url, refName ?? clipName) : (refName ?? clipName);
  const available = ref ? readRange(ref['available_range'], ctx) : null;
  const encoded = encodeURI(name).replace(/#/g, '%23');
  return compact({
    name,
    url: url && url !== encoded ? url : undefined,
    availableFrames: available ? available.start + available.duration : undefined,
    hasVideo: typeof meta?.['hasVideo'] === 'boolean' ? meta['hasVideo'] : true,
    hasAudio: typeof meta?.['hasAudio'] === 'boolean' ? meta['hasAudio'] : true,
    width: typeof meta?.['width'] === 'number' ? meta['width'] : undefined,
    height: typeof meta?.['height'] === 'number' ? meta['height'] : undefined,
    hash: typeof meta?.['hash'] === 'string' ? meta['hash'] : undefined,
    driveId: typeof meta?.['driveId'] === 'string' ? meta['driveId'] : undefined,
  }) as MediaReference;
}

function speedOf(node: Json): number {
  if (!Array.isArray(node['effects'])) return 1;
  let speed = 1;
  for (const effect of node['effects']) {
    const schema = schemaOf(effect);
    if (schema === 'LinearTimeWarp' && isObject(effect)) {
      const scalar = Number(effect['time_scalar']);
      if (Number.isFinite(scalar) && scalar !== 0) speed *= scalar;
    } else if (schema === 'FreezeFrame') {
      speed = 0;
    }
  }
  return speed === 0 ? 1e-6 : speed;
}

function stripped(meta: MetaBag | undefined, keys: string[]): MetaBag | undefined {
  if (!meta) return undefined;
  const out = { ...meta };
  for (const key of keys) delete out[key];
  return Object.keys(out).length > 0 ? out : undefined;
}

function readItem(node: unknown, ctx: ReadCtx, kind: 'video' | 'audio'): InterchangeItem | null {
  if (!isObject(node)) return null;
  const schema = schemaOf(node);
  const name = typeof node['name'] === 'string' ? node['name'] : '';
  const meta = ourMeta(node);
  const enabled = node['enabled'] !== false;
  if (schema === 'Gap') return { type: 'gap', duration: readRange(node['source_range'], ctx)?.duration ?? 0 };
  if (schema === 'Transition') {
    return compact({
      type: 'transition' as const,
      name: name || 'dissolve',
      inOffset: readTime(node['in_offset'], ctx),
      outOffset: readTime(node['out_offset'], ctx),
      meta,
    });
  }
  const range = readRange(node['source_range'], ctx);
  if (schema === 'Stack') {
    const tracks = (Array.isArray(node['children']) ? node['children'] : [])
      .map((child) => readTrack(child, ctx))
      .filter((track): track is InterchangeTrack => track !== null);
    assignRoles(tracks);
    const length = tracks.reduce((max, t) => Math.max(max, t.items.reduce((s, i) => s + (i.type === 'transition' ? 0 : i.duration), 0)), 0);
    return compact({
      type: 'stack' as const,
      name,
      sourceIn: range?.start ?? 0,
      duration: range?.duration ?? length,
      enabled,
      tracks,
      length,
      meta,
    });
  }
  if (schema !== 'Clip') return null;
  const ref = readMedia(node);
  if (schemaOf(ref) === 'GeneratorReference' && ref?.['generator_kind'] === TITLE_GENERATOR) {
    const params = isObject(ref['parameters']) ? ref['parameters'] : {};
    return compact({
      type: 'title' as const,
      text: typeof params['text'] === 'string' ? params['text'] : name,
      duration: range?.duration ?? 0,
      enabled,
      meta,
    });
  }
  const available = ref ? readRange(ref['available_range'], ctx) : null;
  const timeMap = Array.isArray(meta?.['timeMap']) ? (meta['timeMap'] as Array<{ at: number; source: number }>) : undefined;
  const volume = isObject(meta?.['volume']) ? (meta['volume'] as { db: number; keys: Array<{ at: number; db: number }> }) : undefined;
  const media = readMediaReference(ref, name, ctx);
  if (kind === 'audio' && !metaObject(ourMeta(ref ?? {}), 'media')) media.hasVideo = false;
  return compact({
    type: 'clip' as const,
    name,
    media,
    sourceIn: range?.start ?? available?.start ?? 0,
    duration: range?.duration ?? available?.duration ?? 0,
    speed: speedOf(node),
    timeMap,
    enabled,
    volume,
    meta: stripped(meta, ['timeMap', 'volume']),
  });
}

function readTrack(node: unknown, ctx: ReadCtx): InterchangeTrack | null {
  if (!isObject(node) || schemaOf(node) !== 'Track') return null;
  const kind = node['kind'] === 'Audio' ? 'audio' : 'video';
  const meta = ourMeta(node);
  const items = (Array.isArray(node['children']) ? node['children'] : [])
    .map((child) => readItem(child, ctx, kind))
    .filter((item): item is InterchangeItem => item !== null);
  const role = meta?.['role'];
  return compact({
    kind,
    role: role === 'base' || role === 'overlay' || role === 'titles' || role === 'audio' ? role : kind === 'audio' ? 'audio' : 'overlay',
    name: typeof node['name'] === 'string' ? node['name'] : '',
    enabled: node['enabled'] !== false,
    items,
    meta: stripped(meta, ['role']),
  }) as InterchangeTrack;
}

/** Roles for tracks a foreign tool wrote: titles by content, the first other video track is the base. */
function assignRoles(tracks: InterchangeTrack[]): void {
  if (tracks.some((t) => t.role === 'base')) return;
  for (const track of tracks) {
    if (track.kind === 'video' && track.items.length > 0 && track.items.every((i) => i.type === 'title' || i.type === 'gap')) {
      track.role = 'titles';
    }
  }
  const base = tracks.find((t) => t.kind === 'video' && t.role !== 'titles');
  if (base) base.role = 'base';
}

function timelineRate(doc: Json, meta: MetaBag | undefined): TimecodeRate {
  const format = metaObject(meta, 'format');
  if (isTimecodeRateId(format?.['rate'])) return timecodeRate(format['rate']);
  const start = isObject(doc['global_start_time']) ? Number(doc['global_start_time']['rate']) : NaN;
  let fps = start;
  if (!(fps > 0)) {
    const find = (node: unknown): number => {
      if (!isObject(node)) return NaN;
      const range = isObject(node['source_range']) ? node['source_range'] : null;
      const r = range && isObject(range['duration']) ? Number(range['duration']['rate']) : NaN;
      if (r > 0) return r;
      for (const child of Array.isArray(node['children']) ? node['children'] : []) {
        const found = find(child);
        if (found > 0) return found;
      }
      return NaN;
    };
    fps = find(doc['tracks']);
  }
  return timecodeRateForFps(fps > 0 ? fps : 30) ?? timecodeRate(undefined);
}

/** Parse OTIO JSON into the neutral timeline. Throws `OtioError` on a file that is not an OTIO timeline. */
export function readOtio(text: string): InterchangeTimeline {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new OtioError(`Not OTIO JSON: ${(error as Error).message}`);
  }
  if (!isObject(doc) || schemaOf(doc) !== 'Timeline') throw new OtioError('Not an OpenTimelineIO timeline (no Timeline schema).');
  const meta = ourMeta(doc);
  const rate = timelineRate(doc, meta);
  const ctx: ReadCtx = { rate };
  const stack = isObject(doc['tracks']) ? doc['tracks'] : {};
  const tracks = (Array.isArray(stack['children']) ? stack['children'] : [])
    .map((child) => readTrack(child, ctx))
    .filter((track): track is InterchangeTrack => track !== null);
  assignRoles(tracks);
  const markers: InterchangeMarker[] = [];
  const captions: InterchangeCaption[] = [];
  for (const node of Array.isArray(stack['markers']) ? stack['markers'] : []) {
    if (!isObject(node)) continue;
    const range = readRange(node['marked_range'], ctx) ?? { start: 0, duration: 0 };
    const markerMeta = ourMeta(node);
    const name = typeof node['name'] === 'string' ? node['name'] : '';
    if (metaObject(markerMeta, 'caption') || (!markerMeta && node['color'] === CAPTION_COLOR)) {
      captions.push(compact({ frame: range.start, duration: Math.max(1, range.duration), text: name, meta: markerMeta }));
    } else {
      markers.push(compact({ frame: range.start, duration: range.duration, name, meta: markerMeta }));
    }
  }
  const format = metaObject(meta, 'format');
  return compact({
    name: typeof doc['name'] === 'string' ? doc['name'] : 'Timeline',
    rate,
    startFrame: readTime(doc['global_start_time'], ctx),
    width: typeof format?.['width'] === 'number' ? format['width'] : 1920,
    height: typeof format?.['height'] === 'number' ? format['height'] : 1080,
    tracks,
    markers,
    captions,
    meta: stripped(meta, ['format']),
  }) as InterchangeTimeline;
}
