/**
 * FCPXML (1.8–1.11) reader → the neutral timeline.
 *
 * Takes the first `project` → `sequence`, its format's `frameDuration` and
 * `tcFormat` for the rate, and `tcStart` for the timecode start. The primary
 * spine becomes the base track; connected items become one track per lane
 * (positive lanes video, negative audio; titles by content), placed at their
 * parent's record position plus their `offset` in the parent's local time —
 * the convention `fcpxml.ts` writes. `ref-clip`s of compound-clip `media`
 * become nested stacks. Clip Stacker metadata (`md key="com.clipstacker.*"`)
 * is read where present; everything else is taken from the document.
 */

import { fcpTimeToFrames, parseRationalSeconds } from './rational';
import { isTimecodeRateId, timecodeRate, timecodeRateForFps, type TimecodeRate } from './timecode';
import { FCPXML_META_PREFIX, compact } from './mapping';
import type {
  InterchangeCaption,
  InterchangeClip,
  InterchangeItem,
  InterchangeMarker,
  InterchangeStack,
  InterchangeTimeline,
  InterchangeTitle,
  InterchangeTrack,
  MediaReference,
  MetaBag,
} from './model';
import { childrenOf, findDeep, firstChild, parseXml, textContent, type XmlNode } from './xml';

class FcpxmlError extends Error {
  override name = 'FcpxmlError';
}

interface ReadCtx {
  rate: TimecodeRate;
  resources: Map<string, XmlNode>;
  formatSize: { width: number; height: number };
}

interface LaneEntry {
  lane: number;
  role?: InterchangeTrack['role'];
  kind?: 'video' | 'audio';
  name?: string;
  enabled?: boolean;
  meta?: MetaBag;
}

interface Connected {
  lane: number;
  start: number;
  item: Exclude<InterchangeItem, { type: 'gap' | 'transition' }>;
}

const frames = (ctx: ReadCtx, text: string | undefined) => fcpTimeToFrames(text, ctx.rate);

/** `com.clipstacker.<key>` metadata of an element, parsed (null when absent or not JSON). */
function ourMd(node: XmlNode | null | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const entry of childrenOf(firstChild(node, 'metadata'), 'md')) {
    const key = entry.attrs['key'] ?? '';
    if (!key.startsWith(FCPXML_META_PREFIX)) continue;
    try {
      out.set(key.slice(FCPXML_META_PREFIX.length), JSON.parse(entry.attrs['value'] ?? 'null'));
    } catch {
      // A foreign tool mangled the value: ignore it.
    }
  }
  return out;
}

function objectOr<T>(value: unknown): T | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined;
}

function fileNameOf(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const path = src.replace(/^[a-z]+:\/\/[^/]*/i, '').split(/[?#]/)[0] ?? '';
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function readMedia(ctx: ReadCtx, assetId: string | undefined, fallbackName: string): MediaReference {
  const asset = assetId ? ctx.resources.get(assetId) : undefined;
  const meta = objectOr<Record<string, unknown>>(ourMd(asset).get('media'));
  const src = firstChild(asset, 'media-rep')?.attrs['src'] ?? asset?.attrs['src'];
  const name =
    (typeof meta?.['name'] === 'string' && meta['name']) || asset?.attrs['name'] || fileNameOf(src) || fallbackName;
  const encoded = encodeURI(name).replace(/#/g, '%23');
  const format = asset?.attrs['format'] ? ctx.resources.get(asset.attrs['format']) : undefined;
  const width = typeof meta?.['width'] === 'number' ? meta['width'] : format?.attrs['width'] ? Number(format.attrs['width']) : undefined;
  const height = typeof meta?.['height'] === 'number' ? meta['height'] : format?.attrs['height'] ? Number(format.attrs['height']) : undefined;
  const assetStart = frames(ctx, asset?.attrs['start']);
  const duration = asset?.attrs['duration'] ? frames(ctx, asset.attrs['duration']) : undefined;
  return compact({
    name,
    url: src && src !== encoded ? src : undefined,
    availableFrames: duration !== undefined ? assetStart + duration : undefined,
    hasVideo: asset ? asset.attrs['hasVideo'] !== '0' : true,
    hasAudio: asset ? asset.attrs['hasAudio'] !== '0' : true,
    width,
    height,
    hash: typeof meta?.['hash'] === 'string' ? meta['hash'] : undefined,
    driveId: typeof meta?.['driveId'] === 'string' ? meta['driveId'] : undefined,
  }) as MediaReference;
}

function parseDb(text: string | undefined): number {
  const value = parseFloat(String(text ?? '0').replace(/dB$/i, ''));
  return Number.isFinite(value) ? value : 0;
}

function readVolume(ctx: ReadCtx, node: XmlNode, localStart: number): InterchangeClip['volume'] {
  const adjust = firstChild(node, 'adjust-volume');
  if (!adjust) return undefined;
  const keys = childrenOf(findDeep(adjust, 'keyframeAnimation'), 'keyframe').map((key) => ({
    at: frames(ctx, key.attrs['time']) - localStart,
    db: parseDb(key.attrs['value']),
  }));
  return { db: parseDb(adjust.attrs['amount']), keys };
}

function readTimeMap(ctx: ReadCtx, node: XmlNode, start: number): { speed: number; sourceIn: number; timeMap?: InterchangeClip['timeMap'] } {
  const points = childrenOf(firstChild(node, 'timeMap'), 'timept').map((p) => ({ t: frames(ctx, p.attrs['time']), v: frames(ctx, p.attrs['value']) }));
  if (points.length < 2) return { speed: 1, sourceIn: points[0]?.v ?? start };
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const span = last.t - first.t;
  const speed = span !== 0 ? (last.v - first.v) / span : 1;
  const sourceIn = Math.round(first.v + (start - first.t) * speed);
  const linear = points.length === 2;
  return linear ? { speed, sourceIn } : { speed, sourceIn, timeMap: points.map((p) => ({ at: p.t - start, source: p.v })) };
}

/** The media item one spine / connected element is, or null for elements it does not import. */
function readElement(ctx: ReadCtx, node: XmlNode): Exclude<InterchangeItem, { type: 'gap' | 'transition' }> | null {
  const md = ourMd(node);
  const duration = frames(ctx, node.attrs['duration']);
  const start = frames(ctx, node.attrs['start']);
  const enabled = node.attrs['enabled'] !== '0';
  const name = node.attrs['name'] ?? '';
  if (node.tag === 'asset-clip' || node.tag === 'clip' || node.tag === 'video' || node.tag === 'audio') {
    const ref = node.attrs['ref'] ?? firstChild(node, 'video')?.attrs['ref'] ?? firstChild(node, 'asset-clip')?.attrs['ref'] ?? firstChild(node, 'audio')?.attrs['ref'];
    const media = readMedia(ctx, ref, name || 'media');
    if (node.tag === 'audio') media.hasVideo = false;
    const timing = readTimeMap(ctx, node, start);
    return compact({
      type: 'clip' as const,
      name: name || media.name,
      media,
      sourceIn: timing.sourceIn,
      duration,
      speed: timing.speed,
      timeMap: timing.timeMap,
      enabled,
      volume: readVolume(ctx, node, start),
      meta: objectOr<MetaBag>(md.get('clip')),
    }) as InterchangeClip;
  }
  if (node.tag === 'ref-clip') {
    const mediaNode = node.attrs['ref'] ? ctx.resources.get(node.attrs['ref']) : undefined;
    const sequence = firstChild(mediaNode, 'sequence');
    const nested = sequence ? readSequence(ctx, sequence) : { tracks: [], captions: [], markers: [], length: 0 };
    return compact({
      type: 'stack' as const,
      name: name || mediaNode?.attrs['name'] || 'Compound Clip',
      sourceIn: start,
      duration,
      enabled,
      tracks: nested.tracks,
      length: nested.length,
      meta: objectOr<MetaBag>(md.get('clip')),
    }) as InterchangeStack;
  }
  if (node.tag === 'title') {
    return compact({
      type: 'title' as const,
      text: textContent(firstChild(node, 'text')) || name,
      duration,
      enabled,
      meta: objectOr<MetaBag>(md.get('title')),
    }) as InterchangeTitle;
  }
  return null;
}

const SPINE_MEDIA = new Set(['asset-clip', 'clip', 'ref-clip', 'title', 'video', 'audio', 'sync-clip', 'mc-clip']);
const ANCHORED = new Set(['asset-clip', 'clip', 'ref-clip', 'title', 'video', 'audio', 'caption']);

/** Local time origin of a spine element: its `start`, else its `offset`. */
function localOrigin(ctx: ReadCtx, node: XmlNode): number {
  return node.attrs['start'] !== undefined ? frames(ctx, node.attrs['start']) : frames(ctx, node.attrs['offset']);
}

function readSequence(
  ctx: ReadCtx,
  sequence: XmlNode,
): { tracks: InterchangeTrack[]; captions: InterchangeCaption[]; markers: InterchangeMarker[]; length: number } {
  const md = ourMd(sequence);
  const laneTable = Array.isArray(md.get('lanes')) ? (md.get('lanes') as LaneEntry[]) : [];
  const transitionMeta = Array.isArray(md.get('transitions')) ? (md.get('transitions') as MetaBag[]) : [];
  const captionMeta = Array.isArray(md.get('captions')) ? (md.get('captions') as MetaBag[]) : [];
  const markerMeta = Array.isArray(md.get('markers')) ? (md.get('markers') as MetaBag[]) : [];
  const spine = firstChild(sequence, 'spine');
  const base: InterchangeItem[] = [];
  const connected: Connected[] = [];
  const captions: InterchangeCaption[] = [];
  const markers: InterchangeMarker[] = [];
  let at = 0;
  let transitionIndex = 0;

  const visitAnchored = (parent: XmlNode, parentStart: number) => {
    const origin = localOrigin(ctx, parent);
    for (const child of parent.children) {
      if (child.tag === 'marker' || child.tag === 'chapter-marker') {
        markers.push({
          frame: parentStart + frames(ctx, child.attrs['start']) - origin,
          duration: frames(ctx, child.attrs['duration']),
          name: child.attrs['value'] ?? '',
        });
        continue;
      }
      if (!ANCHORED.has(child.tag) || child.attrs['lane'] === undefined) continue;
      const start = parentStart + frames(ctx, child.attrs['offset']) - origin;
      if (child.tag === 'caption') {
        captions.push({ frame: start, duration: frames(ctx, child.attrs['duration']), text: textContent(firstChild(child, 'text')) || child.attrs['name'] || '' });
        continue;
      }
      const item = readElement(ctx, child);
      if (item) connected.push({ lane: Number(child.attrs['lane']) || 0, start, item });
    }
  };

  for (const node of spine?.children ?? []) {
    if (node.tag === 'transition') {
      const duration = frames(ctx, node.attrs['duration']);
      const offset = frames(ctx, node.attrs['offset']) - frames(ctx, sequence.attrs['tcStart']);
      const inOffset = Math.max(0, Math.min(duration, at - offset));
      base.push(compact({
        type: 'transition' as const,
        name: node.attrs['name'] ?? 'dissolve',
        inOffset,
        outOffset: duration - inOffset,
        meta: transitionMeta[transitionIndex],
      }));
      transitionIndex += 1;
      continue;
    }
    const duration = frames(ctx, node.attrs['duration']);
    if (node.tag === 'gap') base.push({ type: 'gap', duration });
    else if (SPINE_MEDIA.has(node.tag)) {
      const target = node.tag === 'sync-clip' || node.tag === 'mc-clip' ? (firstChild(node, 'spine')?.children.find((c) => SPINE_MEDIA.has(c.tag)) ?? node) : node;
      const item = readElement(ctx, target);
      base.push(item ? { ...item, duration } as InterchangeItem : { type: 'gap', duration });
    } else continue;
    visitAnchored(node, at);
    at += duration;
  }
  // The writer pads the spine with a gap under connected items; the base lane never ends in one.
  while (base.length > 0 && base[base.length - 1]!.type === 'gap') base.pop();
  const tracks = laneTracks(base, connected, laneTable);
  captions.sort((a, b) => a.frame - b.frame);
  captions.forEach((caption, i) => {
    if (captionMeta[i]) caption.meta = captionMeta[i];
  });
  markers.sort((a, b) => a.frame - b.frame);
  markers.forEach((marker, i) => {
    if (markerMeta[i]) marker.meta = markerMeta[i];
  });
  const length = fcpTimeToFrames(sequence.attrs['duration'], ctx.rate) || at;
  return { tracks, captions, markers, length };
}

function laneTracks(base: InterchangeItem[], connected: Connected[], table: LaneEntry[]): InterchangeTrack[] {
  const entry = (lane: number) => table.find((e) => e.lane === lane);
  const tracks: InterchangeTrack[] = [];
  const baseEntry = entry(0);
  if (base.some((item) => item.type !== 'gap') || baseEntry) {
    tracks.push(compact({
      kind: 'video' as const,
      role: 'base' as const,
      name: baseEntry?.name ?? 'Video 1',
      enabled: baseEntry?.enabled ?? !base.some((item) => 'enabled' in item && item.enabled === false),
      items: base,
      meta: baseEntry?.meta,
    }));
  }
  const laneNumbers = [...new Set([...connected.map((c) => c.lane), ...table.map((e) => e.lane).filter((l) => l !== 0)])];
  const tableOrder = (lane: number) => {
    const index = table.findIndex((e) => e.lane === lane);
    return index >= 0 ? index : 1000 + (lane > 0 ? lane : 500 - lane);
  };
  laneNumbers.sort((a, b) => tableOrder(a) - tableOrder(b));
  for (const lane of laneNumbers) {
    const items = connected.filter((c) => c.lane === lane).sort((a, b) => a.start - b.start);
    const e = entry(lane);
    const kind = e?.kind ?? (lane < 0 ? 'audio' : 'video');
    const titles = items.length > 0 && items.every((c) => c.item.type === 'title');
    const role = e?.role ?? (kind === 'audio' ? 'audio' : titles ? 'titles' : 'overlay');
    const subs: Array<{ cursor: number; items: InterchangeItem[] }> = [];
    for (const { item, start } of items) {
      let sub = subs.find((s) => s.cursor <= start);
      if (!sub) {
        sub = { cursor: 0, items: [] };
        subs.push(sub);
      }
      if (start > sub.cursor) sub.items.push({ type: 'gap', duration: start - sub.cursor });
      sub.items.push(item);
      sub.cursor = start + item.duration;
    }
    if (subs.length === 0) subs.push({ cursor: 0, items: [] });
    for (const sub of subs) {
      tracks.push(compact({
        kind,
        role,
        name: e?.name ?? `${kind === 'audio' ? 'Audio' : 'Video'} ${Math.abs(lane) + (kind === 'audio' ? 0 : 1)}`,
        enabled: e?.enabled ?? !sub.items.some((item) => 'enabled' in item && item.enabled === false),
        items: sub.items,
        meta: e?.meta,
      }) as InterchangeTrack);
    }
  }
  return tracks;
}

function sequenceRate(sequence: XmlNode, format: XmlNode | undefined, md: Map<string, unknown>): TimecodeRate {
  const saved = objectOr<{ rate?: unknown }>(md.get('timecode'))?.rate;
  const duration = parseRationalSeconds(format?.attrs['frameDuration']);
  const fps = duration ? duration[1] / duration[0] : 30;
  const dropFrame = sequence.attrs['tcFormat'] === 'DF';
  if (isTimecodeRateId(saved)) {
    const rate = timecodeRate(saved);
    if (Math.abs(rate.num / rate.den - fps) < 0.005 && rate.dropFrame === dropFrame) return rate;
  }
  return timecodeRateForFps(fps, dropFrame) ?? timecodeRate(undefined);
}

/** Parse an FCPXML document into the neutral timeline. Throws `FcpxmlError` when it holds no sequence. */
export function readFcpxml(text: string): InterchangeTimeline {
  const root = parseXml(text);
  if (!root || root.tag !== 'fcpxml') throw new FcpxmlError('Not an FCPXML document (no <fcpxml> root).');
  const resources = new Map<string, XmlNode>();
  for (const node of firstChild(root, 'resources')?.children ?? []) if (node.attrs['id']) resources.set(node.attrs['id'], node);
  const body = { ...root, children: root.children.filter((child) => child.tag !== 'resources') };
  const project = findDeep(body, 'project');
  const sequence = firstChild(project, 'sequence') ?? findDeep(body, 'sequence');
  if (!sequence) throw new FcpxmlError('The FCPXML holds no project sequence.');
  const md = ourMd(sequence);
  const format = sequence.attrs['format'] ? resources.get(sequence.attrs['format']) : undefined;
  const rate = sequenceRate(sequence, format, md);
  const ctx: ReadCtx = {
    rate,
    resources,
    formatSize: { width: Number(format?.attrs['width']) || 1920, height: Number(format?.attrs['height']) || 1080 },
  };
  const read = readSequence(ctx, sequence);
  const projectMeta = objectOr<MetaBag>(md.get('project'));
  return compact({
    name: project?.attrs['name'] ?? 'Timeline',
    rate,
    startFrame: fcpTimeToFrames(sequence.attrs['tcStart'], rate),
    width: ctx.formatSize.width,
    height: ctx.formatSize.height,
    tracks: read.tracks,
    markers: read.markers,
    captions: read.captions,
    meta: projectMeta ? { project: projectMeta } : undefined,
  }) as InterchangeTimeline;
}
