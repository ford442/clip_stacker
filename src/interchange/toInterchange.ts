/**
 * Project → neutral timeline (`model.ts`), the export half of `mapping.ts`.
 *
 * Works from the saved JSON (`Project`), read through `projectView`, so every
 * caller exports the same way. Record positions on the main lane come from
 * the same segment maths the compositor uses (`buildClipTimelineSegments`),
 * not from the stored `TrackItem.startTime`; every other lane is placed at
 * its items' start times. Rounding happens once, on absolute positions, so
 * durations add up to the programme length exactly.
 */

import type {
  CaptionEntry,
  Clip,
  ClipTransition,
  Project,
  SerializedClip,
  SerializedSequence,
  SerializedTransition,
  SyncMarker,
  TextOverlay,
  Track,
} from '../types';
import { getClipDuration } from '../timeline/clipTiming';
import { getTimelineClips } from '../timeline/timelineClips';
import { buildClipTimelineSegments } from '../composition/previewComposition';
import { isActiveTransition } from '../composition/previewCompositionSegments';
import { sampleKeyframes } from '../timeline/keyframes';
import { getClipPlaybackRate, getTrimmedSourceDuration } from '../timeline/playbackRate';
import { clipIsReversed } from '../timeline/reverseClip';
import { cycleDurationForClip, sourceTimeAtOutputLocal, wrapOutputLocalToCycle } from '../timeline/timeRemap';
import { normalizeCaptions } from '../captions/subtitles';
import { secondsToFrames } from './rational';
import { timecodeRate, timecodeStartFrames, type TimecodeRate } from './timecode';
import { compact } from './mapping';
import {
  timelineLength,
  type InterchangeClip,
  type InterchangeItem,
  type InterchangeStack,
  type InterchangeTimeline,
  type InterchangeTrack,
  type MediaReference,
} from './model';
import { projectView, type ProjectBodyView, type ProjectView } from './projectView';

/** Facts about a clip's media the saved JSON does not hold (computed by the caller). */
export interface MediaFacts {
  hash?: string;
  driveId?: string;
  url?: string;
}

export interface ToInterchangeOptions {
  /** Timeline name (default: the project's export file name, else `Clip Stacker`). */
  name?: string;
  /** Output size (default: the layout reference resolution, else 1920x1080). */
  width?: number;
  height?: number;
  /** Extra media facts keyed by file name. */
  media?: Readonly<Record<string, MediaFacts>>;
}

/** Deepest nesting exported (`NESTED_SEQUENCE_MAX_DEPTH`). */
const MAX_DEPTH = 8;

interface Ctx {
  rate: TimecodeRate;
  view: ProjectView;
  media: Readonly<Record<string, MediaFacts>>;
  /** Sequence ids being exported above this body (cycle guard). */
  path: string[];
  /** Every pool clip that became an item. */
  placed: Set<string>;
  sequencesPlaced: Set<string>;
}

const frames = (ctx: Ctx, seconds: number) => secondsToFrames(seconds, ctx.rate);

/** The saved clip, minus what the format itself carries (name, file, media bytes). */
export function clipMeta(saved: SerializedClip): Record<string, unknown> {
  const { title: _title, fileName, sourceMediaDataUrl: _data, sourceMediaUrl: _url, ...rest } = saved;
  // A sequence clip's file name has no home in the format (it has no media).
  return compact({ ...(rest as Record<string, unknown>), fileName: saved.source ? fileName : undefined });
}

function mediaReference(ctx: Ctx, clip: Clip, saved: SerializedClip): MediaReference {
  const name = saved.fileName || clip.file.name;
  const facts = ctx.media[name];
  const video = clip.kind === 'video';
  return compact({
    name,
    url: facts?.url ?? saved.offline?.url,
    availableFrames: frames(ctx, clip.duration),
    hasVideo: video,
    hasAudio: clip.hasAudio !== false && !clip.stillImage,
    width: clip.videoWidth,
    height: clip.videoHeight,
    hash: facts?.hash ?? saved.offline?.hash ?? saved.proxy?.hash,
    driveId: facts?.driveId ?? saved.offline?.driveId,
  }) as MediaReference;
}

/** Source seconds shown at output-local `t` (loops wrap into their cycle). */
function sourceAt(clip: Clip, t: number): number {
  const { cycleLocalT } = wrapOutputLocalToCycle(clip, t);
  return sourceTimeAtOutputLocal(clip, cycleLocalT);
}

function averageSpeed(clip: Clip): number {
  const rate = clip.automation?.playbackRate?.length
    ? getTrimmedSourceDuration(clip) / Math.max(1e-9, cycleDurationForClip(clip))
    : getClipPlaybackRate(clip);
  return clipIsReversed(clip) ? -rate : rate;
}

const gainDb = (gain: number) => (gain > 0 ? 20 * Math.log10(gain) : -96);
const roundDb = (db: number) => Math.round(db * 100) / 100;

/**
 * One media clip covering record `[startF, endF)` of a placement that starts
 * at `windowStart` seconds (handles before / after it are transition media).
 */
function mediaItem(
  ctx: Ctx,
  clip: Clip,
  startF: number,
  endF: number,
  windowStart: number,
  enabled: boolean,
  meta: Record<string, unknown>,
): InterchangeClip | InterchangeStack {
  const saved = ctx.view.saved.get(clip.id);
  const savedClip = saved ?? ({ id: clip.id, title: clip.title, fileName: clip.file.name } as SerializedClip);
  const startSec = (startF * ctx.rate.den) / ctx.rate.num;
  const local = startSec - windowStart;
  ctx.placed.add(clip.id);
  const sequenceId = clip.source?.type === 'sequence' ? clip.source.sequenceId : null;
  if (sequenceId !== null) return stackItem(ctx, clip, savedClip, sequenceId, startF, endF, local, enabled, meta);

  const item: InterchangeClip = {
    type: 'clip',
    name: clip.title,
    media: mediaReference(ctx, clip, savedClip),
    sourceIn: frames(ctx, sourceAt(clip, local)),
    duration: Math.max(0, endF - startF),
    speed: averageSpeed(clip),
    enabled,
    meta: { clip: clipMeta(savedClip), ...meta },
  };
  const ramp = clip.automation?.playbackRate;
  if (ramp?.length) {
    const ends = [local, local + (endF - startF) / (ctx.rate.num / ctx.rate.den)];
    const times = [...new Set([...ends, ...ramp.map((k) => k.t).filter((t) => t > ends[0]! && t < ends[1]!)])].sort(
      (a, b) => a - b,
    );
    item.timeMap = times.map((t) => ({
      at: frames(ctx, windowStart + t) - startF,
      source: frames(ctx, sourceAt(clip, t)),
    }));
  }
  const volumeKeys = clip.automation?.volume ?? [];
  const baseGain = clip.volume ?? 1;
  if (baseGain !== 1 || volumeKeys.length > 0) {
    item.volume = {
      db: roundDb(gainDb(volumeKeys.length > 0 ? sampleKeyframes(volumeKeys, local, baseGain) : baseGain)),
      keys: volumeKeys.map((k) => ({ at: frames(ctx, windowStart + k.t) - startF, db: roundDb(gainDb(k.value)) })),
    };
  }
  return item;
}

function stackItem(
  ctx: Ctx,
  clip: Clip,
  saved: SerializedClip,
  sequenceId: string,
  startF: number,
  endF: number,
  local: number,
  enabled: boolean,
  meta: Record<string, unknown>,
): InterchangeStack {
  const sequence = ctx.view.sequences.get(sequenceId);
  const nested =
    sequence && ctx.path.length < MAX_DEPTH && !ctx.path.includes(sequenceId)
      ? bodyTracks({ ...ctx, path: [...ctx.path, sequenceId] }, sequence.body)
      : [];
  if (sequence) ctx.sequencesPlaced.add(sequenceId);
  return {
    type: 'stack',
    name: clip.title,
    sourceIn: frames(ctx, clip.trimStart + local),
    duration: Math.max(0, endF - startF),
    enabled,
    tracks: nested,
    length: timelineLength(nested),
    meta: {
      clip: clipMeta(saved),
      sequence: { id: sequenceId, name: sequence?.name ?? clip.title },
      ...meta,
    },
  };
}

function laneMeta(track: Track, order: number): Record<string, unknown> {
  return compact({
    id: track.id,
    order,
    kind: track.kind,
    label: track.label,
    muted: track.muted ? true : undefined,
    locked: track.locked ? true : undefined,
    height: track.height,
    audioFx: track.audioFx,
    duck: track.duck,
  });
}

function trackName(track: Track, fallback: string): string {
  return track.label?.trim() || fallback;
}

function serializedTransition(t: ClipTransition): SerializedTransition {
  return compact({
    afterClipIndex: t.afterClipIndex,
    type: t.type,
    duration: t.duration,
    params: t.params,
    customShader: t.customShader,
    morphSegment: t.morphSegment
      ? compact({
          fileName: t.morphSegment.fileName,
          duration: t.morphSegment.duration,
          status: t.morphSegment.status,
          error: t.morphSegment.error,
        })
      : undefined,
  }) as SerializedTransition;
}

function baseTrack(ctx: Ctx, body: ProjectBodyView, track: Track, order: number, timeline: Clip[]): InterchangeTrack {
  const byId = new Map(timeline.map((clip) => [clip.id, clip]));
  const schedule = [...track.items]
    .sort((a, b) => a.startTime - b.startTime)
    .map((item) => byId.get(item.clipId))
    .filter((clip): clip is Clip => Boolean(clip));
  const segments = buildClipTimelineSegments(schedule, body.transitions, schedule.map((_, i) => i));
  const incoming = (slot: number) =>
    slot >= 1 ? body.transitions.find((t) => t.afterClipIndex === slot && isActiveTransition(t)) : undefined;
  const cutFrame = (slot: number) => {
    const t = incoming(slot);
    const seg = segments[slot];
    return t && seg ? frames(ctx, seg.startTime + t.duration / 2) : null;
  };
  const items: InterchangeItem[] = [];
  const enabled = !track.muted;
  segments.forEach((seg, slot) => {
    const transition = incoming(slot);
    const inCut = cutFrame(slot);
    if (transition && inCut !== null) {
      const prev = segments[slot - 1];
      items.push({
        type: 'transition',
        name: transition.type,
        inOffset: Math.max(0, inCut - frames(ctx, seg.startTime)),
        outOffset: Math.max(0, frames(ctx, prev ? prev.endTime : seg.startTime + transition.duration) - inCut),
        meta: { transition: serializedTransition(transition) },
      });
    }
    const startF = inCut ?? frames(ctx, seg.startTime);
    const endF = cutFrame(slot + 1) ?? frames(ctx, seg.endTime);
    items.push(mediaItem(ctx, seg.clip, startF, Math.max(startF, endF), seg.startTime, enabled, {}));
  });
  return {
    kind: 'video',
    role: 'base',
    name: trackName(track, 'Video 1'),
    enabled,
    items,
    meta: {
      lane: laneMeta(track, order),
      transitions: body.transitions.map(serializedTransition),
    },
  };
}

/** A lane placed by absolute start times; overlapping items spill into extra tracks. */
function placedTracks(
  ctx: Ctx,
  track: Track,
  order: number,
  timeline: Map<string, Clip>,
  role: 'overlay' | 'audio',
  fallbackName: string,
): InterchangeTrack[] {
  const subs: Array<{ cursor: number; items: InterchangeItem[] }> = [];
  const enabled = !track.muted;
  for (const placement of [...track.items].sort((a, b) => a.startTime - b.startTime)) {
    const clip = timeline.get(placement.clipId);
    if (!clip) continue;
    const startF = frames(ctx, placement.startTime);
    const endF = Math.max(startF, frames(ctx, placement.startTime + getClipDuration(clip)));
    let sub = subs.find((s) => s.cursor <= startF);
    if (!sub) {
      sub = { cursor: 0, items: [] };
      subs.push(sub);
    }
    if (startF > sub.cursor) sub.items.push({ type: 'gap', duration: startF - sub.cursor });
    sub.items.push(mediaItem(ctx, clip, startF, endF, placement.startTime, enabled, { startTime: placement.startTime }));
    sub.cursor = endF;
  }
  if (subs.length === 0) subs.push({ cursor: 0, items: [] });
  return subs.map((sub, index) => ({
    kind: role === 'audio' ? 'audio' : 'video',
    role,
    name: trackName(track, fallbackName),
    enabled,
    items: sub.items,
    meta: { lane: laneMeta(track, order), ...(index > 0 ? { overflow: index } : {}) },
  }));
}

/** Titles run the whole programme, so each title is one track of its lane. */
function titleTracks(
  track: Track | null,
  order: number,
  overlays: TextOverlay[],
  programme: number,
  placedAt: Map<string, number>,
  fallbackName: string,
): InterchangeTrack[] {
  const enabled = !track?.muted;
  const tracks = overlays.map((overlay, index): InterchangeTrack => ({
    kind: 'video',
    role: 'titles',
    name: track ? trackName(track, fallbackName) : fallbackName,
    enabled,
    items: [
      {
        type: 'title',
        text: overlay.text,
        duration: programme,
        enabled,
        meta: { overlay, ...(placedAt.has(overlay.id) ? { startTime: placedAt.get(overlay.id) } : {}) },
      },
    ],
    meta: track ? { lane: laneMeta(track, order), ...(index > 0 ? { overflow: index } : {}) } : { unplaced: true },
  }));
  if (tracks.length === 0 && track) {
    tracks.push({ kind: 'video', role: 'titles', name: trackName(track, fallbackName), enabled, items: [], meta: { lane: laneMeta(track, order) } });
  }
  return tracks;
}

function bodyTracks(ctx: Ctx, body: ProjectBodyView): InterchangeTrack[] {
  const timelineClips = getTimelineClips(body.clips, body.groups);
  const timeline = new Map(timelineClips.map((clip) => [clip.id, clip]));
  const firstVideo = body.tracks.find((track) => track.kind === 'video') ?? null;
  const media: InterchangeTrack[] = [];
  let videoIndex = 0;
  let audioIndex = 0;
  body.tracks.forEach((track, order) => {
    if (track.kind === 'video') {
      videoIndex += 1;
      if (track === firstVideo) media.push(baseTrack(ctx, body, track, order, timelineClips));
      else media.push(...placedTracks(ctx, track, order, timeline, 'overlay', `Video ${videoIndex}`));
    } else if (track.kind === 'audio') {
      audioIndex += 1;
      media.push(...placedTracks(ctx, track, order, timeline, 'audio', `Audio ${audioIndex}`));
    }
  });
  const programme = Math.max(1, timelineLength(media));
  const overlays = new Map(body.textOverlays.map((overlay) => [overlay.id, overlay]));
  const placedAt = new Map<string, number>();
  const titleLanes: InterchangeTrack[] = [];
  let titlesIndex = 0;
  body.tracks.forEach((track, order) => {
    if (track.kind !== 'text') return;
    titlesIndex += 1;
    const onLane = [...track.items]
      .sort((a, b) => a.startTime - b.startTime)
      .filter((item) => overlays.has(item.clipId) && !placedAt.has(item.clipId));
    for (const item of onLane) placedAt.set(item.clipId, item.startTime);
    titleLanes.push(
      ...titleTracks(track, order, onLane.map((item) => overlays.get(item.clipId)!), programme, placedAt, `Titles ${titlesIndex}`),
    );
  });
  const unplaced = body.textOverlays.filter((overlay) => !placedAt.has(overlay.id));
  if (unplaced.length > 0) titleLanes.push(...titleTracks(null, -1, unplaced, programme, placedAt, 'Titles'));
  // Bottom to top: video lanes, titles above them, then audio.
  const video = media.filter((track) => track.kind === 'video');
  const audio = media.filter((track) => track.kind === 'audio');
  return [...video, ...titleLanes, ...audio];
}

function captionsOf(ctx: Ctx, captions: CaptionEntry[] | undefined): InterchangeTimeline['captions'] {
  return normalizeCaptions(captions ?? []).map((caption) => {
    const frame = frames(ctx, caption.startSec);
    return {
      frame,
      duration: Math.max(1, frames(ctx, caption.endSec) - frame),
      text: caption.text,
      meta: { caption: compact({ ...caption, style: caption.style && Object.keys(caption.style).length > 0 ? caption.style : undefined }) },
    };
  });
}

function markersOf(ctx: Ctx, markers: SyncMarker[] | undefined): InterchangeTimeline['markers'] {
  return (markers ?? []).map((marker) => ({
    frame: frames(ctx, marker.time),
    duration: 0,
    name: marker.text,
    meta: { marker: compact({ ...marker }) },
  }));
}

function outputSize(project: Project, options: ToInterchangeOptions): { width: number; height: number } {
  const [w, h] = (project.layoutReferenceResolution ?? '').split('x').map(Number);
  return {
    width: options.width ?? (w && w > 0 ? w : 1920),
    height: options.height ?? (h && h > 0 ? h : 1080),
  };
}

/** Project-level state the formats have no element for. */
function projectMeta(project: Project, ctx: Ctx): Record<string, unknown> {
  const extraClips = project.clips.filter((clip) => !ctx.placed.has(clip.id));
  const extraIds = new Set(extraClips.map((clip) => clip.id));
  const extraPlacements: Array<{ sequenceId: string | null; trackId: string; clipId: string; startTime: number }> = [];
  const collect = (sequenceId: string | null, tracks: Track[]) => {
    for (const track of tracks) {
      if (track.kind === 'text') continue;
      for (const item of track.items) {
        if (extraIds.has(item.clipId)) extraPlacements.push({ sequenceId, trackId: track.id, clipId: item.clipId, startTime: item.startTime });
      }
    }
  };
  collect(null, ctx.view.root.tracks);
  for (const [id, seq] of ctx.view.sequences) collect(id, seq.body.tracks);
  const unplacedSequences = (project.sequences ?? []).filter((seq) => !ctx.sequencesPlaced.has(seq.id));
  const owner = new Map((project.sequences ?? []).flatMap((seq) => seq.clipIds.map((id) => [id, seq.id] as const)));
  return compact({
    schemaVersion: project.schemaVersion,
    layoutReferenceResolution: project.layoutReferenceResolution,
    finishing: project.finishing,
    colorGrade: project.colorGrade,
    colorManagement: project.colorManagement,
    masterBus: project.masterBus,
    captionStyle: project.captionStyle && Object.keys(project.captionStyle).length > 0 ? project.captionStyle : undefined,
    masterAudio: project.masterAudio
      ? compact({ ...project.masterAudio, sourceMediaDataUrl: undefined, sourceMediaUrl: undefined })
      : undefined,
    clipGroups: project.clipGroups?.length
      ? [...project.clipGroups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : undefined,
    timecodeStart: project.timecodeStart,
    timecodeRate: project.timecodeRate,
    extraClips: extraClips.length
      ? [...extraClips].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((clip) => compact({ ...clip, sourceMediaDataUrl: undefined, sourceMediaUrl: undefined, owner: owner.get(clip.id) }))
      : undefined,
    extraPlacements: extraPlacements.length ? extraPlacements : undefined,
    unplacedSequences: unplacedSequences.length
      ? unplacedSequences.map((seq): SerializedSequence => seq)
      : undefined,
  });
}

/** The neutral timeline for a saved project. */
export function toInterchange(project: Project, options: ToInterchangeOptions = {}): InterchangeTimeline {
  const rate = timecodeRate(project.timecodeRate);
  const ctx: Ctx = {
    rate,
    view: projectView(project),
    media: options.media ?? {},
    path: [],
    placed: new Set(),
    sequencesPlaced: new Set(),
  };
  const tracks = bodyTracks(ctx, ctx.view.root);
  // Unplaced sequences' bodies still count as placed clips (they ride in metadata whole).
  for (const seq of project.sequences ?? []) {
    if (!ctx.sequencesPlaced.has(seq.id)) for (const id of seq.clipIds) ctx.placed.add(id);
  }
  const { width, height } = outputSize(project, options);
  return {
    name: options.name ?? 'Clip Stacker',
    rate,
    startFrame: timecodeStartFrames(project.timecodeStart, rate),
    width,
    height,
    tracks,
    markers: markersOf(ctx, project.masterAudioMarkers),
    captions: captionsOf(ctx, project.captions),
    meta: { project: projectMeta(project, ctx) },
  };
}
