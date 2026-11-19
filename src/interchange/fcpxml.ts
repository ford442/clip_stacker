/**
 * FCPXML 1.11 writer: the neutral timeline as `resources` (`format`,
 * `asset`, `effect`, compound-clip `media`) and `library` → `event` →
 * `project` → `sequence` → `spine`.
 *
 * - The main lane is the primary spine (`asset-clip`, `ref-clip`, `gap`,
 *   `transition` centred on its edit). Spine offsets include `tcStart`.
 * - Every other track is connected to the spine element under its start:
 *   video lanes on lanes 1…n (titles above them), audio on −1…−n, captions
 *   on the lane above everything. A connected `offset` is in its parent's
 *   local time (`start` + record distance), the convention `fcpxmlRead.ts`
 *   reads back; a trailing `gap` extends the spine under items past its end.
 * - Clip Stacker metadata rides in `metadata` / `md` (`com.clipstacker.*`):
 *   per clip / title / compound clip inline, and per lane, transition and
 *   caption in the sequence's own metadata, where FCPXML allows it.
 */

import { formatRationalSeconds, frameDurationText } from './rational';
import { FCPXML_META_PREFIX, compact, stableJson } from './mapping';
import {
  placedItems,
  timelineLength,
  type InterchangeCaption,
  type InterchangeClip,
  type InterchangeItem,
  type InterchangeMarker,
  type InterchangeStack,
  type InterchangeTimeline,
  type InterchangeTitle,
  type InterchangeTrack,
  type MediaReference,
  type MetaBag,
} from './model';
import { buildXml, el, type XmlNode } from './xml';
import type { TimecodeRate } from './timecode';

export const FCPXML_VERSION = '1.11';
/** Final Cut Pro's built-in Cross Dissolve. */
export const CROSS_DISSOLVE_UID = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265';
/** Final Cut Pro's Basic Title. */
export const BASIC_TITLE_UID = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

interface Resources {
  nodes: XmlNode[];
  formatId: string;
  dissolveId: string | null;
  titleId: string | null;
  assets: Map<string, string>;
  media: Map<string, string>;
  next: number;
}

interface WriteCtx {
  rate: TimecodeRate;
  res: Resources;
  styleCounter: number;
}

const time = (ctx: WriteCtx, frames: number) => formatRationalSeconds(frames, ctx.rate);

function md(key: string, value: unknown): XmlNode {
  return el('md', { key: `${FCPXML_META_PREFIX}${key}`, value: stableJson(value) });
}

function metadataNode(entries: Array<[string, unknown]>): XmlNode[] {
  const present = entries.filter(([, value]) => value !== undefined && !(value && typeof value === 'object' && Object.keys(value).length === 0));
  return present.length > 0 ? [el('metadata', {}, present.map(([key, value]) => md(key, value)))] : [];
}

function nextId(res: Resources): string {
  res.next += 1;
  return `r${res.next}`;
}

function assetFor(ctx: WriteCtx, media: MediaReference): string {
  const key = media.name;
  const existing = ctx.res.assets.get(key);
  if (existing) return existing;
  const id = nextId(ctx.res);
  ctx.res.assets.set(key, id);
  const src = media.url ?? encodeURI(media.name).replace(/#/g, '%23');
  ctx.res.nodes.push(
    el(
      'asset',
      {
        id,
        name: media.name,
        start: '0s',
        duration: time(ctx, media.availableFrames ?? 0),
        hasVideo: media.hasVideo ? '1' : '0',
        hasAudio: media.hasAudio ? '1' : '0',
        format: media.hasVideo ? ctx.res.formatId : undefined,
        audioSources: media.hasAudio ? '1' : undefined,
        audioChannels: media.hasAudio ? '2' : undefined,
        audioRate: media.hasAudio ? '48000' : undefined,
      },
      [
        el('media-rep', { kind: 'original-media', src }),
        ...metadataNode([
          ['media', compact({ name: media.name, width: media.width, height: media.height, hash: media.hash, driveId: media.driveId })],
        ]),
      ],
    ),
  );
  return id;
}

function dissolveEffect(ctx: WriteCtx): string {
  if (!ctx.res.dissolveId) {
    ctx.res.dissolveId = nextId(ctx.res);
    ctx.res.nodes.push(el('effect', { id: ctx.res.dissolveId, name: 'Cross Dissolve', uid: CROSS_DISSOLVE_UID }));
  }
  return ctx.res.dissolveId;
}

function titleEffect(ctx: WriteCtx): string {
  if (!ctx.res.titleId) {
    ctx.res.titleId = nextId(ctx.res);
    ctx.res.nodes.push(el('effect', { id: ctx.res.titleId, name: 'Basic Title', uid: BASIC_TITLE_UID }));
  }
  return ctx.res.titleId;
}

/** `#rrggbb` → FCPXML `r g b a` (0–1); white when unparsable. */
export function fcpColor(color: unknown, alpha = 1): string {
  const match = typeof color === 'string' ? /^#?([0-9a-f]{6})/i.exec(color.replace(/^0x/i, '#')) : null;
  if (!match) return `1 1 1 ${alpha}`;
  const hex = match[1]!;
  const channel = (i: number) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4).replace(/\.?0+$/, '') || '0';
  return `${channel(0)} ${channel(2)} ${channel(4)} ${alpha}`;
}

/** One `text` + `text-style-def` pair (ids unique in the document). */
function styledText(ctx: WriteCtx, text: string, style: { font?: unknown; size?: unknown; color?: unknown }, placement?: string): XmlNode[] {
  ctx.styleCounter += 1;
  const id = `ts${ctx.styleCounter}`;
  return [
    el('text', placement ? { placement } : {}, [el('text-style', { ref: id }, [], text)]),
    el('text-style-def', { id }, [
      el('text-style', {
        font: typeof style.font === 'string' && style.font ? style.font : 'Helvetica',
        fontSize: typeof style.size === 'number' ? style.size : 48,
        fontColor: fcpColor(style.color),
      }),
    ]),
  ];
}

function timeMapNode(ctx: WriteCtx, item: InterchangeClip): XmlNode[] {
  if (item.speed === 1 && !item.timeMap) return [];
  const points = item.timeMap ?? [
    { at: 0, source: item.sourceIn },
    { at: item.duration, source: Math.round(item.sourceIn + item.duration * item.speed) },
  ];
  return [
    el(
      'timeMap',
      {},
      points.map((p) => el('timept', { time: time(ctx, item.sourceIn + p.at), value: time(ctx, p.source), interp: 'linear' })),
    ),
  ];
}

function volumeNode(ctx: WriteCtx, item: InterchangeClip): XmlNode[] {
  if (!item.volume) return [];
  const amount = `${item.volume.db}dB`;
  if (item.volume.keys.length === 0) return [el('adjust-volume', { amount })];
  return [
    el('adjust-volume', { amount }, [
      el('param', { name: 'amount' }, [
        el(
          'keyframeAnimation',
          {},
          item.volume.keys.map((key) => el('keyframe', { time: time(ctx, item.sourceIn + key.at), value: `${key.db}dB` })),
        ),
      ]),
    ]),
  ];
}

interface SpineSlot {
  node: XmlNode;
  start: number;
  duration: number;
  /** Local time of the slot's first frame (its `start`). */
  localStart: number;
  anchored: XmlNode[];
  markers: XmlNode[];
  meta: XmlNode[];
}

function clipNode(ctx: WriteCtx, item: InterchangeClip, offset: string, lane?: number): { node: XmlNode; meta: XmlNode[]; head: XmlNode[] } {
  const ref = assetFor(ctx, item.media);
  return {
    node: el('asset-clip', {
      ref,
      lane,
      offset,
      name: item.name,
      start: time(ctx, item.sourceIn),
      duration: time(ctx, item.duration),
      enabled: item.enabled ? undefined : '0',
      tcFormat: ctx.rate.dropFrame ? 'DF' : 'NDF',
    }),
    head: [...timeMapNode(ctx, item), ...volumeNode(ctx, item)],
    meta: metadataNode([['clip', item.meta]]),
  };
}

function stackNode(ctx: WriteCtx, item: InterchangeStack, offset: string, lane?: number): { node: XmlNode; meta: XmlNode[]; head: XmlNode[] } {
  const sequenceId = typeof (item.meta?.['sequence'] as { id?: unknown } | undefined)?.id === 'string'
    ? String((item.meta?.['sequence'] as { id: string }).id)
    : `${item.name}#${ctx.res.next}`;
  let ref = ctx.res.media.get(sequenceId);
  if (!ref) {
    ref = nextId(ctx.res);
    ctx.res.media.set(sequenceId, ref);
    // Reserve the slot before recursing so nested resources follow it.
    const placeholder = el('media', { id: ref, name: item.name });
    ctx.res.nodes.push(placeholder);
    const nested = sequenceNode(ctx, item.tracks, 0, [], [], item.length, []);
    placeholder.children.push(nested);
  }
  return {
    node: el('ref-clip', {
      ref,
      lane,
      offset,
      name: item.name,
      start: time(ctx, item.sourceIn),
      duration: time(ctx, item.duration),
      enabled: item.enabled ? undefined : '0',
    }),
    head: [],
    meta: metadataNode([['clip', item.meta]]),
  };
}

function titleNode(ctx: WriteCtx, item: InterchangeTitle, offset: string, lane: number): XmlNode {
  const overlay = (item.meta?.['overlay'] ?? {}) as { font?: unknown; fontsize?: unknown; fontcolor?: unknown };
  return el(
    'title',
    {
      ref: titleEffect(ctx),
      lane,
      offset,
      name: item.text.split('\n')[0] || 'Title',
      start: '0s',
      duration: time(ctx, item.duration),
      enabled: item.enabled ? undefined : '0',
    },
    [
      ...styledText(ctx, item.text, { font: overlay.font, size: overlay.fontsize, color: overlay.fontcolor }),
      ...metadataNode([['title', item.meta]]),
    ],
  );
}

function captionNode(ctx: WriteCtx, caption: InterchangeCaption, offset: string, lane: number): XmlNode {
  return el(
    'caption',
    {
      lane,
      offset,
      name: caption.text.split('\n')[0] || 'Caption',
      start: '0s',
      duration: time(ctx, caption.duration),
      role: 'iTT?captionFormat=ITT.en',
    },
    styledText(ctx, caption.text, { size: 13 }, 'bottom'),
  );
}

function spineSlots(ctx: WriteCtx, base: InterchangeTrack | null, startFrame: number, programme: number): { slots: SpineSlot[]; order: Array<SpineSlot | XmlNode> } {
  const slots: SpineSlot[] = [];
  const order: Array<SpineSlot | XmlNode> = [];
  let at = 0;
  for (const { item, start } of base ? placedItems(base) : []) {
    const offset = time(ctx, startFrame + start);
    if (item.type === 'transition') {
      const node = el(
        'transition',
        { name: item.name, offset: time(ctx, startFrame + start - item.inOffset), duration: time(ctx, item.inOffset + item.outOffset) },
        [el('filter-video', { ref: dissolveEffect(ctx), name: 'Cross Dissolve' })],
      );
      order.push(node);
      continue;
    }
    let made: { node: XmlNode; meta: XmlNode[]; head: XmlNode[]; localStart: number };
    if (item.type === 'clip') made = { ...clipNode(ctx, item, offset), localStart: item.sourceIn };
    else if (item.type === 'stack') made = { ...stackNode(ctx, item, offset), localStart: item.sourceIn };
    else made = { node: el('gap', { name: 'Gap', offset, start: offset, duration: time(ctx, item.duration) }), meta: [], head: [], localStart: startFrame + start };
    made.node.children.push(...made.head);
    const slot: SpineSlot = { node: made.node, start, duration: item.duration, localStart: made.localStart, anchored: [], markers: [], meta: made.meta };
    slots.push(slot);
    order.push(slot);
    at = start + item.duration;
  }
  if (at < programme || slots.length === 0) {
    const offset = time(ctx, startFrame + at);
    const duration = Math.max(1, programme - at);
    const slot: SpineSlot = {
      node: el('gap', { name: 'Gap', offset, start: offset, duration: time(ctx, duration) }),
      start: at,
      duration,
      localStart: startFrame + at,
      anchored: [],
      markers: [],
      meta: [],
    };
    slots.push(slot);
    order.push(slot);
  }
  return { slots, order };
}

function slotAt(slots: SpineSlot[], frame: number): SpineSlot {
  return slots.find((slot) => frame >= slot.start && frame < slot.start + slot.duration) ?? slots[slots.length - 1]!;
}

const localOffset = (ctx: WriteCtx, slot: SpineSlot, frame: number) => time(ctx, slot.localStart + (frame - slot.start));

/** A `sequence` element for tracks (the root's, or a compound clip's). */
function sequenceNode(
  ctx: WriteCtx,
  tracks: InterchangeTrack[],
  startFrame: number,
  captions: InterchangeCaption[],
  markers: InterchangeMarker[],
  length: number,
  sequenceMeta: Array<[string, unknown]>,
): XmlNode {
  const base = tracks.find((track) => track.role === 'base') ?? null;
  const programme = Math.max(length, timelineLength(tracks), ...captions.map((c) => c.frame + c.duration));
  const { slots, order } = spineSlots(ctx, base, startFrame, programme);

  const lanes: Array<{ lane: number; role: string; kind: string; name: string; enabled: boolean; meta?: MetaBag }> = [];
  let up = 0;
  let down = 0;
  for (const track of tracks) {
    if (track === base) {
      lanes.push(compact({ lane: 0, role: track.role, kind: track.kind, name: track.name, enabled: track.enabled, meta: track.meta }));
      continue;
    }
    const lane = track.kind === 'audio' ? --down : ++up;
    lanes.push(compact({ lane, role: track.role, kind: track.kind, name: track.name, enabled: track.enabled, meta: track.meta }));
    for (const { item, start } of placedItems(track)) {
      if (item.type === 'gap' || item.type === 'transition') continue;
      const slot = slotAt(slots, start);
      const offset = localOffset(ctx, slot, start);
      slot.anchored.push(anchoredNode(ctx, item, offset, lane));
    }
  }
  const captionLane = up + 1;
  for (const caption of captions) {
    const slot = slotAt(slots, caption.frame);
    slot.anchored.push(captionNode(ctx, caption, localOffset(ctx, slot, caption.frame), captionLane));
  }
  // In time order, as a reader walking the spine meets them (their metadata is matched by index).
  const sortedMarkers = [...markers].sort((a, b) => a.frame - b.frame);
  for (const marker of sortedMarkers) {
    const slot = slotAt(slots, marker.frame);
    slot.markers.push(el('marker', { start: localOffset(ctx, slot, marker.frame), duration: time(ctx, Math.max(1, marker.duration)), value: marker.name }));
  }
  for (const slot of slots) slot.node.children.push(...slot.anchored, ...slot.markers, ...slot.meta);

  const meta = metadataNode([
    ...sequenceMeta,
    ['lanes', lanes],
    ['transitions', base ? base.items.filter((i) => i.type === 'transition').map((i) => i.meta ?? {}) : []],
    ['captions', captions.map((c) => c.meta ?? {})],
    ['markers', sortedMarkers.map((m) => m.meta ?? {})],
  ]);
  return el(
    'sequence',
    {
      format: ctx.res.formatId,
      duration: time(ctx, programme),
      tcStart: time(ctx, startFrame),
      tcFormat: ctx.rate.dropFrame ? 'DF' : 'NDF',
      audioLayout: 'stereo',
      audioRate: '48k',
    },
    [el('spine', {}, order.map((entry) => ('node' in entry && 'anchored' in entry ? entry.node : entry))), ...meta],
  );
}

function anchoredNode(ctx: WriteCtx, item: Exclude<InterchangeItem, { type: 'gap' | 'transition' }>, offset: string, lane: number): XmlNode {
  if (item.type === 'title') return titleNode(ctx, item, offset, lane);
  const made = item.type === 'clip' ? clipNode(ctx, item, offset, lane) : stackNode(ctx, item, offset, lane);
  made.node.children.push(...made.head, ...made.meta);
  return made.node;
}

/** The neutral timeline as an FCPXML 1.11 document. */
export function writeFcpxml(timeline: InterchangeTimeline): string {
  const res: Resources = { nodes: [], formatId: 'r1', dissolveId: null, titleId: null, assets: new Map(), media: new Map(), next: 1 };
  res.nodes.push(
    el('format', {
      id: res.formatId,
      frameDuration: frameDurationText(timeline.rate),
      width: timeline.width,
      height: timeline.height,
      colorSpace: '1-1-1 (Rec. 709)',
    }),
  );
  const ctx: WriteCtx = { rate: timeline.rate, res, styleCounter: 0 };
  const sequence = sequenceNode(ctx, timeline.tracks, timeline.startFrame, timeline.captions, timeline.markers, 0, [
    ['project', timeline.meta?.['project']],
    ['timecode', { rate: timeline.rate.id }],
  ]);
  const doc = el('fcpxml', { version: FCPXML_VERSION }, [
    el('resources', {}, res.nodes),
    el('library', {}, [el('event', { name: 'Clip Stacker' }, [el('project', { name: timeline.name }, [sequence])])]),
  ]);
  return buildXml(doc, 'fcpxml');
}
