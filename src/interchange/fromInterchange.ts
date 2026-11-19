/**
 * Neutral timeline → project, the import half of `mapping.ts`.
 *
 * Produces the same `Project` JSON a save writes, so the app loads it through
 * its normal load path (`applyProjectData`) and a headless caller can write it
 * to disk. Metadata in the `clip_stacker` namespace is used only while it
 * still agrees with the file: an item whose position, length or speed a
 * foreign tool changed is rebuilt from the file's own values (constant speed,
 * no loops), and the rest of its settings are kept.
 */

import type {
  CaptionEntry,
  Project,
  SerializedClip,
  SerializedSequence,
  SerializedTrack,
  SerializedTransition,
  SyncMarker,
  TextOverlay,
  TrackItem,
  TrackKind,
} from '../types';
import { PROJECT_SCHEMA_VERSION } from '../types';
import { createClipId } from '../media/media';
import { getClipDuration } from '../timeline/clipTiming';
import { isRegisteredTransitionType } from '../webgpu/transitions/registry';
import { MORPH_TRANSITION_TYPE } from '../remote/morphTransition';
import { framesToSeconds, secondsToFrames } from './rational';
import { DEFAULT_TIMECODE_RATE, framesToTimecode, timecodeStartFrames } from './timecode';
import { agreeing, compact, metaNumber, metaObject } from './mapping';
import type {
  InterchangeClip,
  InterchangeItem,
  InterchangeStack,
  InterchangeTimeline,
  InterchangeTitle,
  InterchangeTrack,
  MediaReference,
} from './model';
import { pseudoClip } from './projectView';

export interface FromInterchangeResult {
  project: Project;
  /** The media each imported clip needs (by clip id); sequence clips have none. */
  media: Map<string, MediaReference>;
  warnings: string[];
}

interface Lane {
  meta: Record<string, unknown> | null;
  kind: TrackKind;
  role: InterchangeTrack['role'];
  name: string;
  enabled: boolean;
  tracks: InterchangeTrack[];
  order: number;
}

interface Body {
  clipIds: string[];
  tracks: SerializedTrack[];
  transitions: SerializedTransition[];
  textOverlays: TextOverlay[];
}

interface Ctx {
  timeline: InterchangeTimeline;
  clips: SerializedClip[];
  media: Map<string, MediaReference>;
  sequences: Map<string, SerializedSequence>;
  usedIds: Set<string>;
  warnings: string[];
  frameSec: number;
}

const sec = (ctx: Ctx, frames: number) => framesToSeconds(frames, ctx.timeline.rate);
const toFrames = (ctx: Ctx, seconds: number) => secondsToFrames(seconds, ctx.timeline.rate);

/** `wanted` when it is a free id in namespace `ns`, else a fresh one. */
function uniqueId(ctx: Ctx, ns: string, wanted: unknown, make: () => string): string {
  let id = typeof wanted === 'string' && wanted && !ctx.usedIds.has(`${ns}:${wanted}`) ? wanted : make();
  while (ctx.usedIds.has(`${ns}:${id}`)) id = make();
  ctx.usedIds.add(`${ns}:${id}`);
  return id;
}

function laneKey(track: InterchangeTrack, index: number): string {
  const id = metaObject(track.meta, 'lane')?.['id'];
  return typeof id === 'string' && id ? `lane:${id}` : `track:${index}`;
}

/** Interchange tracks grouped back into lanes (overflow tracks rejoin their lane). */
function lanesOf(tracks: InterchangeTrack[]): { lanes: Lane[]; unplacedTitles: InterchangeTrack[] } {
  const lanes = new Map<string, Lane>();
  const unplacedTitles: InterchangeTrack[] = [];
  tracks.forEach((track, index) => {
    if (track.meta?.['unplaced'] === true) {
      unplacedTitles.push(track);
      return;
    }
    const key = laneKey(track, index);
    const meta = metaObject(track.meta, 'lane');
    let lane = lanes.get(key);
    if (!lane) {
      const kind: TrackKind = track.role === 'titles' ? 'text' : track.kind === 'audio' ? 'audio' : 'video';
      lane = {
        meta,
        kind,
        role: track.role,
        name: track.name,
        enabled: track.enabled,
        tracks: [],
        order: metaNumber(meta, 'order') ?? 1000 + index,
      };
      lanes.set(key, lane);
    }
    lane.tracks.push(track);
  });
  return { lanes: [...lanes.values()].sort((a, b) => a.order - b.order), unplacedTitles };
}

function laneLabel(lane: Lane, fallback: string): string | undefined {
  const label = lane.meta?.['label'];
  const saved = typeof label === 'string' ? label : undefined;
  const exported = saved?.trim() || fallback;
  return lane.name === exported ? saved : lane.name;
}

function serializedLane(ctx: Ctx, scope: string, lane: Lane, fallback: string, items: TrackItem[]): SerializedTrack {
  const meta = lane.meta;
  // Lane ids are unique per timeline: a nested sequence reuses `v1` / `v2`.
  const id = uniqueId(ctx, `track:${scope}`, meta?.['id'], () => `track-${createClipId()}`);
  const label = laneLabel(lane, fallback);
  const muted = !lane.enabled;
  return compact({
    id,
    kind: lane.kind,
    label,
    items,
    muted: muted ? true : undefined,
    locked: meta?.['locked'] === true ? true : undefined,
    height: metaNumber(meta, 'height') ?? undefined,
    audioFx: lane.kind !== 'text' && Array.isArray(meta?.['audioFx']) ? (meta['audioFx'] as SerializedTrack['audioFx']) : undefined,
    duck: lane.kind !== 'text' && meta?.['duck'] !== undefined ? (meta['duck'] as SerializedTrack['duck']) : undefined,
  }) as SerializedTrack;
}

const dbToGain = (db: number) => (db <= -96 ? 0 : Math.pow(10, db / 20));

/**
 * The clip a media item becomes. `windowStartF` / `windowEndF` is the record
 * span of the whole clip (handles under transitions included); `startF` is
 * where the item itself starts.
 */
function importClip(
  ctx: Ctx,
  item: InterchangeClip | InterchangeStack,
  kind: 'video' | 'audio',
  startF: number,
  windowStartF: number,
  windowEndF: number,
): SerializedClip {
  const meta = metaObject(item.meta, 'clip');
  const saved = (meta ?? {}) as Partial<SerializedClip>;
  const id = uniqueId(ctx, 'clip', saved.id, createClipId);
  const speed = item.type === 'clip' ? item.speed : 1;
  const rate = Math.abs(speed) > 1e-9 ? Math.abs(speed) : 1;
  const windowFrames = Math.max(0, windowEndF - windowStartF);
  const handleBefore = startF - windowStartF;
  const fileTrimStart = Math.max(0, sec(ctx, item.sourceIn) - sec(ctx, handleBefore) * rate);
  const fileTrimEnd = fileTrimStart + sec(ctx, windowFrames) * rate;

  const sequence = item.type === 'stack' ? metaObject(item.meta, 'sequence') : null;
  const fileName = item.type === 'clip' ? item.media.name : (saved.fileName ?? `${item.name}.sequence`);
  const mediaFrames = item.type === 'clip' ? item.media.availableFrames : item.length;
  const fileDuration = mediaFrames !== undefined && mediaFrames > 0 ? sec(ctx, mediaFrames) : fileTrimEnd;

  // Does the saved clip still describe this placement? (What we would export, to a frame.)
  let agrees = false;
  if (meta && typeof saved.trimStart === 'number' && typeof saved.duration === 'number') {
    const probe = pseudoClip({ title: item.name, fileName, ...saved } as SerializedClip);
    const expectedLength = toFrames(ctx, getClipDuration(probe));
    const expectedIn = toFrames(ctx, saved.trimStart + (saved.reversed ? 0 : sec(ctx, handleBefore) * rate));
    // Ramps, loops and reversal map media time non-linearly: their length decides.
    const nonLinear = saved.reversed === true || (saved.automation?.playbackRate?.length ?? 0) > 0 || (saved.loopCount ?? 1) > 1;
    // Within a frame over the clip: FCPXML stores speed as a frame-rounded time map.
    const speedAgrees = item.type === 'stack' || nonLinear || Math.abs(Math.abs(speed) - rateOf(saved)) * Math.max(1, windowFrames) <= 1.5;
    const inAgrees = nonLinear || Math.abs(expectedIn - item.sourceIn) <= 1;
    agrees = Math.abs(expectedLength - windowFrames) <= 1 && inAgrees && speedAgrees;
  }

  const clip: SerializedClip = agrees
    ? ({ ...saved, id, title: item.name, fileName } as SerializedClip)
    : (compact({
        ...saved,
        id,
        title: item.name,
        fileName,
        kind,
        duration: agreeing(typeof saved.duration === 'number' ? saved.duration : null, fileDuration, ctx.frameSec),
        trimStart: fileTrimStart,
        trimEnd: fileTrimEnd,
        videoFadeIn: saved.videoFadeIn ?? 0,
        videoFadeOut: saved.videoFadeOut ?? 0,
        audioFadeIn: saved.audioFadeIn ?? 0,
        audioFadeOut: saved.audioFadeOut ?? 0,
        playbackRate: rate !== 1 ? rate : undefined,
        reversed: speed < 0 ? true : undefined,
        loopCount: undefined,
        automation: saved.automation
          ? compact({ ...saved.automation, playbackRate: undefined })
          : undefined,
      }) as SerializedClip);
  if (clip.automation && Object.keys(clip.automation).length === 0) delete clip.automation;
  if (item.type === 'clip') {
    if (!meta) {
      if (item.media.width) clip.videoWidth = item.media.width;
      if (item.media.height) clip.videoHeight = item.media.height;
      clip.hasAudio = item.media.hasAudio;
      if (!item.media.hasVideo) clip.kind = 'audio';
    }
    applyVolume(ctx, clip, item, meta !== null, startF - windowStartF);
    ctx.media.set(id, item.media);
  } else {
    const seqId = typeof sequence?.['id'] === 'string' ? sequence['id'] : `seq-${createClipId()}`;
    clip.source = { type: 'sequence', sequenceId: seqId };
    if (!ctx.sequences.has(seqId)) {
      const name = typeof sequence?.['name'] === 'string' ? sequence['name'] : item.name;
      const body = importBody(ctx, item.tracks, seqId);
      ctx.sequences.set(seqId, compact({
        id: seqId,
        name,
        clipIds: body.clipIds,
        tracks: body.tracks.length ? body.tracks : undefined,
        transitions: body.transitions.length ? body.transitions : undefined,
        textOverlays: body.textOverlays.length ? body.textOverlays : undefined,
      }) as SerializedSequence);
    }
  }
  if (!clip.kind) clip.kind = kind;
  ctx.clips.push(clip);
  return clip;
}

function rateOf(saved: Partial<SerializedClip>): number {
  return typeof saved.playbackRate === 'number' && saved.playbackRate > 0 ? saved.playbackRate : 1;
}

/** Volume from the file when it disagrees with what the saved clip would export. */
function applyVolume(ctx: Ctx, clip: SerializedClip, item: InterchangeClip, hadMeta: boolean, localStartF: number): void {
  const fileGain = item.volume ? dbToGain(item.volume.db) : 1;
  const keys = item.volume?.keys ?? [];
  const savedGain = clip.volume ?? 1;
  const savedKeys = clip.automation?.volume ?? [];
  const close = (a: number, b: number) => Math.abs(20 * Math.log10(Math.max(a, 1e-6)) - 20 * Math.log10(Math.max(b, 1e-6))) < 0.01;
  const agrees =
    hadMeta &&
    keys.length === savedKeys.length &&
    (keys.length > 0 || close(fileGain, savedGain)) &&
    keys.every((key, i) => close(dbToGain(key.db), savedKeys[i]!.value));
  if (agrees) return;
  if (keys.length > 0) {
    clip.automation = {
      ...(clip.automation ?? {}),
      volume: keys.map((key) => ({ t: sec(ctx, key.at + localStartF), value: dbToGain(key.db) })),
    };
  } else {
    if (clip.automation?.volume) {
      const { volume: _volume, ...rest } = clip.automation;
      if (Object.keys(rest).length > 0) clip.automation = rest;
      else delete clip.automation;
    }
    if (Math.abs(fileGain - 1) > 1e-6) clip.volume = fileGain;
    else delete clip.volume;
  }
}

function transitionType(name: string): string {
  return isRegisteredTransitionType(name) || name === MORPH_TRANSITION_TYPE ? name : 'dissolve';
}

/** The base lane: clips in order, transitions between them (keyed by the incoming slot). */
function importBase(ctx: Ctx, lane: Lane): { items: TrackItem[]; transitions: SerializedTransition[]; clipIds: string[] } {
  const track = lane.tracks[0];
  const items: TrackItem[] = [];
  const clipIds: string[] = [];
  const fileTransitions: SerializedTransition[] = [];
  if (!track) return { items, transitions: [], clipIds };
  const sequence = track.items;
  let at = 0;
  let slot = -1;
  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i]!;
    if (item.type === 'transition') continue;
    if (item.type === 'gap' || item.type === 'title') {
      // The main lane has no gaps in Clip Stacker: later clips butt up.
      if (item.type === 'gap' && item.duration > 0) ctx.warnings.push('A gap on the main video track was closed up.');
      continue;
    }
    slot += 1;
    const before = sequence[i - 1]?.type === 'transition' ? (sequence[i - 1] as Extract<InterchangeItem, { type: 'transition' }>) : null;
    const after = sequence[i + 1]?.type === 'transition' ? (sequence[i + 1] as Extract<InterchangeItem, { type: 'transition' }>) : null;
    const startF = at;
    // The incoming clip's head handle runs under `inOffset`, the outgoing
    // clip's tail under `outOffset`: the clip's own window spans both.
    const windowStart = startF - (before && slot > 0 ? before.inOffset : 0);
    const windowEnd = startF + item.duration + (after ? after.outOffset : 0);
    if (before && slot > 0) {
      const meta = metaObject(before.meta, 'transition');
      const fileDuration = sec(ctx, before.inOffset + before.outOffset);
      const type = transitionType(before.name);
      const sameType = meta?.['type'] === before.name;
      fileTransitions.push(compact({
        ...(sameType ? (meta as Partial<SerializedTransition>) : {}),
        afterClipIndex: slot,
        type: sameType ? String(meta['type']) : type,
        duration: agreeing(sameType ? metaNumber(meta, 'duration') : null, fileDuration, ctx.frameSec),
      }) as SerializedTransition);
    }
    const clip = importClip(ctx, item, 'video', startF, windowStart, windowEnd);
    clipIds.push(clip.id);
    items.push({ clipId: clip.id, startTime: sec(ctx, windowStart) });
    at += item.duration;
  }
  return { items, transitions: chooseTransitions(ctx, track, fileTransitions), clipIds };
}

/** The saved transition list, while its active entries still match the file's. */
function chooseTransitions(ctx: Ctx, track: InterchangeTrack, fromFile: SerializedTransition[]): SerializedTransition[] {
  const saved = Array.isArray(track.meta?.['transitions']) ? (track.meta['transitions'] as SerializedTransition[]) : null;
  if (!saved) return fromFile;
  const active = saved
    .filter((t) => t.type !== 'none' && t.duration > 0 && fromFile.some((f) => f.afterClipIndex === t.afterClipIndex))
    .sort((a, b) => a.afterClipIndex - b.afterClipIndex);
  const activeCount = saved.filter((t) => t.type !== 'none' && t.duration > 0 && t.afterClipIndex >= 1).length;
  const matches =
    active.length === fromFile.length &&
    activeCount >= active.length &&
    active.every((t, i) => {
      const f = fromFile[i]!;
      return f.afterClipIndex === t.afterClipIndex && f.type === t.type && Math.abs(f.duration - t.duration) <= ctx.frameSec;
    });
  return matches ? saved.map((t) => ({ ...t })) : fromFile;
}

/** An overlay / audio lane: items at their record positions. */
function importPlaced(ctx: Ctx, lane: Lane, kind: 'video' | 'audio', linked: Set<string>): { items: TrackItem[]; clipIds: string[] } {
  const items: TrackItem[] = [];
  const clipIds: string[] = [];
  for (const track of lane.tracks) {
    let at = 0;
    for (const item of track.items) {
      if (item.type === 'transition') continue;
      const startF = at;
      at += item.duration;
      if (item.type !== 'clip' && item.type !== 'stack') continue;
      if (kind === 'audio' && item.type === 'clip' && !item.meta && linked.has(linkKey(item.media.name, startF, item.duration))) {
        continue; // the video clip's own audio, exported as a separate audio item by an NLE
      }
      const clip = importClip(ctx, item, kind, startF, startF, startF + item.duration);
      const exact = metaNumber(item.meta ?? null, 'startTime');
      clipIds.push(clip.id);
      items.push({ clipId: clip.id, startTime: agreeing(exact, sec(ctx, startF), ctx.frameSec) });
    }
  }
  items.sort((a, b) => a.startTime - b.startTime);
  return { items, clipIds };
}

const linkKey = (name: string, start: number, duration: number) => `${name}\u0000${start}\u0000${duration}`;

function defaultOverlay(id: string, text: string): TextOverlay {
  return {
    id,
    text,
    fontsize: 48,
    fontcolor: '#ffffff',
    x: 0.1,
    y: 0.1,
    scrolling: false,
    scrollSpeed: 20,
    box: false,
    boxColor: 'black@0.5',
  };
}

function importTitle(ctx: Ctx, item: InterchangeTitle, startF: number): { overlay: TextOverlay; startTime: number } {
  const saved = metaObject(item.meta, 'overlay') as Partial<TextOverlay> | null;
  const id = uniqueId(ctx, 'title', saved?.id, () => `title-${createClipId()}`);
  const overlay: TextOverlay = saved ? ({ ...saved, id, text: item.text } as TextOverlay) : defaultOverlay(id, item.text);
  const exact = metaNumber(item.meta ?? null, 'startTime');
  return { overlay, startTime: exact ?? sec(ctx, startF) };
}

function importTitles(ctx: Ctx, tracks: InterchangeTrack[]): Array<{ overlay: TextOverlay; startTime: number }> {
  const out: Array<{ overlay: TextOverlay; startTime: number }> = [];
  for (const track of tracks) {
    let at = 0;
    for (const item of track.items) {
      if (item.type === 'transition') continue;
      if (item.type === 'title') out.push(importTitle(ctx, item, at));
      at += item.duration;
    }
  }
  return out;
}

/** Every lane of one timeline (the root, or a stack's tracks). */
function importBody(ctx: Ctx, tracks: InterchangeTrack[], scope: string): Body {
  const { lanes, unplacedTitles } = lanesOf(tracks);
  const body: Body = { clipIds: [], tracks: [], transitions: [], textOverlays: [] };
  const baseLane = lanes.find((lane) => lane.role === 'base') ?? lanes.find((lane) => lane.kind === 'video');
  // An NLE writes a clip's audio as its own item under the video: skip those.
  const linked = new Set<string>();
  for (const lane of lanes) {
    if (lane.kind !== 'video') continue;
    for (const track of lane.tracks) {
      let at = 0;
      for (const item of track.items) {
        if (item.type === 'transition') continue;
        if (item.type === 'clip' && !item.meta) linked.add(linkKey(item.media.name, at, item.duration));
        at += item.duration;
      }
    }
  }
  const counters = { video: 0, audio: 0, text: 0 };
  for (const lane of lanes) {
    counters[lane.kind] += 1;
    const fallback = `${lane.kind === 'video' ? 'Video' : lane.kind === 'audio' ? 'Audio' : 'Titles'} ${counters[lane.kind]}`;
    if (lane.kind === 'text') {
      const titles = importTitles(ctx, lane.tracks);
      body.textOverlays.push(...titles.map((t) => t.overlay));
      const items = titles.map((t) => ({ clipId: t.overlay.id, startTime: t.startTime })).sort((a, b) => a.startTime - b.startTime);
      body.tracks.push(serializedLane(ctx, scope, lane, fallback, items));
      continue;
    }
    if (lane === baseLane) {
      const base = importBase(ctx, lane);
      body.clipIds.push(...base.clipIds);
      body.transitions = base.transitions;
      body.tracks.push(serializedLane(ctx, scope, lane, fallback, base.items));
      continue;
    }
    const placed = importPlaced(ctx, lane, lane.kind === 'audio' ? 'audio' : 'video', linked);
    body.clipIds.push(...placed.clipIds);
    body.tracks.push(serializedLane(ctx, scope, lane, fallback, placed.items));
  }
  body.textOverlays.push(...importTitles(ctx, unplacedTitles).map((t) => t.overlay));
  return body;
}

function importCaptions(ctx: Ctx): CaptionEntry[] {
  return ctx.timeline.captions.map((caption) => {
    const saved = metaObject(caption.meta, 'caption') as Partial<CaptionEntry> | null;
    const start = agreeing(typeof saved?.startSec === 'number' ? saved.startSec : null, sec(ctx, caption.frame), ctx.frameSec);
    const end = agreeing(typeof saved?.endSec === 'number' ? saved.endSec : null, sec(ctx, caption.frame + caption.duration), ctx.frameSec);
    return compact({
      ...(saved ?? {}),
      id: uniqueId(ctx, 'caption', saved?.id, () => `cue-${createClipId()}`),
      startSec: start,
      endSec: Math.max(end, start + ctx.frameSec),
      text: caption.text,
    }) as CaptionEntry;
  });
}

function importMarkers(ctx: Ctx): SyncMarker[] {
  return ctx.timeline.markers.map((marker) => {
    const saved = metaObject(marker.meta, 'marker') as Partial<SyncMarker> | null;
    return compact({
      ...(saved ?? {}),
      id: uniqueId(ctx, 'marker', saved?.id, () => `marker-${createClipId()}`),
      time: agreeing(typeof saved?.time === 'number' ? saved.time : null, sec(ctx, marker.frame), ctx.frameSec),
      text: marker.name,
    }) as SyncMarker;
  });
}

/** Clips and placements the timeline carries only in metadata (inactive A/B variants, unplaced sequences). */
function restoreExtras(ctx: Ctx, projectMeta: Record<string, unknown>, root: Body): void {
  const extras = Array.isArray(projectMeta['extraClips']) ? (projectMeta['extraClips'] as Array<SerializedClip & { owner?: string }>) : [];
  for (const extra of extras) {
    if (ctx.usedIds.has(`clip:${extra.id}`)) continue;
    ctx.usedIds.add(`clip:${extra.id}`);
    const { owner, ...clip } = extra;
    ctx.clips.push(clip);
    if (!clip.source) {
      ctx.media.set(clip.id, {
        name: clip.fileName,
        hasVideo: clip.kind === 'video',
        hasAudio: clip.hasAudio !== false,
        ...(clip.offline?.url ? { url: clip.offline.url } : {}),
      });
    }
    if (owner) ctx.sequences.get(owner)?.clipIds.push(clip.id);
  }
  const sequences = Array.isArray(projectMeta['unplacedSequences']) ? (projectMeta['unplacedSequences'] as SerializedSequence[]) : [];
  for (const seq of sequences) {
    if (!ctx.sequences.has(seq.id)) ctx.sequences.set(seq.id, { ...seq, clipIds: [...seq.clipIds] });
  }
  for (const seq of sequences) {
    const target = ctx.sequences.get(seq.id);
    if (target) target.clipIds = seq.clipIds.filter((id) => ctx.clips.some((clip) => clip.id === id));
  }
  const placements = Array.isArray(projectMeta['extraPlacements'])
    ? (projectMeta['extraPlacements'] as Array<{ sequenceId: string | null; trackId: string; clipId: string; startTime: number }>)
    : [];
  for (const placement of placements) {
    const tracks = placement.sequenceId === null ? root.tracks : ctx.sequences.get(placement.sequenceId)?.tracks;
    const track = tracks?.find((t) => t.id === placement.trackId);
    if (!track || !ctx.clips.some((clip) => clip.id === placement.clipId)) continue;
    track.items.push({ clipId: placement.clipId, startTime: placement.startTime });
    track.items.sort((a, b) => a.startTime - b.startTime);
  }
}

/** The project a neutral timeline describes. */
export function fromInterchange(timeline: InterchangeTimeline): FromInterchangeResult {
  const ctx: Ctx = {
    timeline,
    clips: [],
    media: new Map(),
    sequences: new Map(),
    usedIds: new Set(),
    warnings: [],
    frameSec: framesToSeconds(1, timeline.rate),
  };
  const meta = metaObject(timeline.meta, 'project') ?? {};
  const root = importBody(ctx, timeline.tracks, '');
  restoreExtras(ctx, meta, root);
  const captions = importCaptions(ctx);
  const markers = importMarkers(ctx);

  const savedStart = typeof meta['timecodeStart'] === 'string' ? meta['timecodeStart'] : undefined;
  const savedRate = typeof meta['timecodeRate'] === 'string' ? meta['timecodeRate'] : undefined;
  const rateId = timeline.rate.id;
  const startText = framesToTimecode(timeline.startFrame, timeline.rate);
  const startAgrees = timecodeStartFrames(savedStart, timeline.rate) === timeline.startFrame;
  const sequences = [...ctx.sequences.values()];

  const project: Project = compact({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    layoutReferenceResolution:
      typeof meta['layoutReferenceResolution'] === 'string' ? meta['layoutReferenceResolution'] : `${timeline.width}x${timeline.height}`,
    tracks: root.tracks,
    clips: ctx.clips,
    transitions: root.transitions,
    clipGroups: Array.isArray(meta['clipGroups']) ? (meta['clipGroups'] as Project['clipGroups']) : undefined,
    textOverlays: root.textOverlays.length ? root.textOverlays : undefined,
    captions: captions.length ? captions : undefined,
    captionStyle: meta['captionStyle'] as Project['captionStyle'],
    finishing: meta['finishing'] as Project['finishing'],
    colorGrade: meta['colorGrade'] as Project['colorGrade'],
    colorManagement: meta['colorManagement'] as Project['colorManagement'],
    masterBus: meta['masterBus'] as Project['masterBus'],
    masterAudio: meta['masterAudio'] as Project['masterAudio'],
    masterAudioMarkers: markers.length ? markers : undefined,
    sequences: sequences.length ? sequences : undefined,
    timecodeStart: startAgrees ? savedStart : startText,
    timecodeRate: savedRate === rateId || (savedRate === undefined && rateId === DEFAULT_TIMECODE_RATE) ? (savedRate as Project['timecodeRate']) : rateId,
  }) as Project;
  return { project, media: ctx.media, warnings: [...new Set(ctx.warnings)] };
}
