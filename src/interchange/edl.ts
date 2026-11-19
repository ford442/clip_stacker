/**
 * CMX 3600 EDL ↔ the neutral timeline.
 *
 * An EDL has one video track, two audio tracks and no metadata, so it carries
 * the cut: main-lane clips as `V` (or `AA/V` with sound) events, dissolves as
 * `D` events, constant speed as `M2` lines, clips on the first two audio lanes
 * as `A` / `A2` events, and master-track markers as `* LOC:` comments. File
 * names ride in `* FROM CLIP NAME:` / `* SOURCE FILE:` comments; reels are an
 * 8-character tag of the name. Overlays, titles and captions are not written.
 *
 * A dissolve in an EDL starts at its event's record-in; the neutral model
 * centres it on the edit, so the writer starts each `D` event `inOffset`
 * frames before the cut and the reader splits a `D` of `n` frames into
 * `round(n / 2)` before the cut and the rest after it.
 */

import type { InterchangeClip, InterchangeItem, InterchangeMarker, InterchangeStack, InterchangeTimeline, InterchangeTrack } from './model';
import { placedItems } from './model';
import { framesToTimecode, isTimecodeRateId, timecodeRate, timecodeToFrames, type TimecodeRate } from './timecode';
import { compact } from './mapping';
import type { TimecodeRateId } from '../types';

class EdlError extends Error {
  override name = 'EdlError';
}

const FRAME_RATE_COMMENT = '* FRAME RATE:';

/** An 8-character reel tag from a file name (`demo-clip-a.mp4` → `DEMOCLIP`). */
export function reelName(name: string): string {
  const stem = name.replace(/\.[^.]*$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (stem || 'AX').slice(0, 8);
}

interface EdlEvent {
  reel: string;
  channel: string;
  transition: string;
  duration?: number;
  srcIn: number;
  srcOut: number;
  recIn: number;
  recOut: number;
}

function eventLine(number: number, event: EdlEvent, rate: TimecodeRate): string {
  const tc = (frames: number) => framesToTimecode(frames, rate);
  const duration = event.duration !== undefined ? String(event.duration).padStart(3, '0') : '   ';
  return `${String(number).padStart(3, '0')}  ${event.reel.padEnd(8)} ${event.channel.padEnd(5)} ${event.transition.padEnd(4)} ${duration} ${tc(event.srcIn)} ${tc(event.srcOut)} ${tc(event.recIn)} ${tc(event.recOut)}`;
}

function speedLine(reel: string, speed: number, srcIn: number, rate: TimecodeRate): string {
  const fps = speed * rate.nominal;
  const text = `${fps < 0 ? '-' : ''}${Math.abs(fps).toFixed(1).padStart(5, '0')}`;
  return `M2   ${reel.padEnd(8)}       ${text.padStart(6)}                ${framesToTimecode(srcIn, rate)}`;
}

type MediaItem = InterchangeClip | InterchangeStack;

function mediaName(item: MediaItem): string {
  return item.type === 'clip' ? item.media.name : `${item.name} (sequence)`;
}

function channelFor(item: MediaItem): string {
  return item.type === 'clip' && item.media.hasAudio ? 'AA/V' : 'V';
}

function speedOf(item: MediaItem): number {
  return item.type === 'clip' ? item.speed : 1;
}

/** Comments naming an event's media. */
function nameComments(item: MediaItem, from: 'FROM' | 'TO'): string[] {
  const lines = [`* ${from} CLIP NAME: ${mediaName(item)}`];
  if (item.type === 'clip' && from === 'FROM') lines.push(`* SOURCE FILE: ${item.media.url ?? item.media.name}`);
  return lines;
}

/** The neutral timeline as a CMX 3600 EDL. */
export function writeEdl(timeline: InterchangeTimeline): string {
  const rate = timeline.rate;
  const lines = [
    `TITLE: ${timeline.name.replace(/[\r\n]+/g, ' ').slice(0, 70)}`,
    `FCM: ${rate.dropFrame ? 'DROP FRAME' : 'NON-DROP FRAME'}`,
    `${FRAME_RATE_COMMENT} ${rate.id}`,
    '',
  ];
  let number = 0;
  const start = timeline.startFrame;
  const base = timeline.tracks.find((track) => track.role === 'base' && track.enabled);
  const placed = base ? placedItems(base) : [];
  for (let i = 0; i < placed.length; i++) {
    const { item, start: at } = placed[i]!;
    if (item.type !== 'clip' && item.type !== 'stack') continue;
    const before = placed[i - 1]?.item.type === 'transition' ? (placed[i - 1]!.item as Extract<InterchangeItem, { type: 'transition' }>) : null;
    const after = placed[i + 1]?.item.type === 'transition' ? (placed[i + 1]!.item as Extract<InterchangeItem, { type: 'transition' }>) : null;
    const speed = speedOf(item);
    const reel = reelName(mediaName(item));
    // A clip followed by a dissolve stops at the dissolve's start; the dissolve event carries the rest.
    const tail = after ? after.inOffset : 0;
    const head = before ? before.inOffset : 0;
    const recIn = start + at - head;
    const recOut = start + at + item.duration - tail;
    const srcIn = item.sourceIn - Math.round(head * speed);
    const srcOut = srcIn + (recOut - recIn);
    number += 1;
    if (before) {
      const prev = placed[i - 2]?.item;
      const prevItem = prev && (prev.type === 'clip' || prev.type === 'stack') ? prev : null;
      const prevReel = prevItem ? reelName(mediaName(prevItem)) : 'BL';
      const prevSrc = prevItem ? prevItem.sourceIn + Math.round((prevItem.duration - before.inOffset) * speedOf(prevItem)) : 0;
      lines.push(eventLine(number, { reel: prevReel, channel: prevItem ? channelFor(prevItem) : 'V', transition: 'C', srcIn: prevSrc, srcOut: prevSrc, recIn, recOut: recIn }, rate));
      lines.push(eventLine(number, { reel, channel: channelFor(item), transition: 'D', duration: before.inOffset + before.outOffset, srcIn, srcOut, recIn, recOut }, rate));
      if (speed !== 1) lines.push(speedLine(reel, speed, srcIn, rate));
      if (prevItem) lines.push(...nameComments(prevItem, 'FROM'));
      lines.push(...nameComments(item, prevItem ? 'TO' : 'FROM'));
      if (prevItem && item.type === 'clip') lines.push(`* SOURCE FILE: ${item.media.url ?? item.media.name}`);
    } else {
      lines.push(eventLine(number, { reel, channel: channelFor(item), transition: 'C', srcIn, srcOut, recIn, recOut }, rate));
      if (speed !== 1) lines.push(speedLine(reel, speed, srcIn, rate));
      lines.push(...nameComments(item, 'FROM'));
    }
    lines.push('');
  }
  const audio = timeline.tracks.filter((track) => track.role === 'audio' && track.enabled).slice(0, 2);
  audio.forEach((track, index) => {
    for (const { item, start: at } of placedItems(track)) {
      if (item.type !== 'clip') continue;
      number += 1;
      const reel = reelName(item.media.name);
      const recIn = start + at;
      lines.push(eventLine(number, {
        reel,
        channel: index === 0 ? 'A' : 'A2',
        transition: 'C',
        srcIn: item.sourceIn,
        srcOut: item.sourceIn + item.duration,
        recIn,
        recOut: recIn + item.duration,
      }, rate));
      if (item.speed !== 1) lines.push(speedLine(reel, item.speed, item.sourceIn, rate));
      lines.push(...nameComments(item, 'FROM'), '');
    }
  });
  for (const marker of [...timeline.markers].sort((a, b) => a.frame - b.frame)) {
    lines.push(`* LOC: ${framesToTimecode(start + marker.frame, rate)} RED     ${marker.name.replace(/[\r\n]+/g, ' ')}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------------
// Reading

export interface ReadEdlOptions {
  /** Rate of the timecodes when the EDL does not say (an EDL normally does not). */
  rate?: TimecodeRateId;
}

interface ParsedEvent extends EdlEvent {
  number: number;
  speed?: number;
  fromName?: string;
  toName?: string;
  sourceFile?: string;
}

function parseRate(text: string, options: ReadEdlOptions): TimecodeRate {
  const dropFrame = /^FCM:\s*DROP FRAME/im.test(text);
  const declared = /^\* FRAME RATE:\s*(\S+)/im.exec(text)?.[1];
  const rate = timecodeRate(isTimecodeRateId(declared) ? declared : options.rate);
  // FCM decides drop frame; only the 29.97 / 59.94 families have it.
  if (dropFrame && !rate.dropFrame) return timecodeRate(rate.nominal === 60 ? '59.94df' : '29.97df');
  if (!dropFrame && rate.dropFrame) return timecodeRate(rate.nominal === 60 ? '59.94' : '29.97');
  return rate;
}

function parseEvents(text: string, rate: TimecodeRate): { events: ParsedEvent[]; markers: Array<{ frame: number; name: string }> } {
  const events: ParsedEvent[] = [];
  const markers: Array<{ frame: number; name: string }> = [];
  let last: ParsedEvent | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const tokens = line.trim().split(/\s+/);
    if (/^\d{3,}\s/.test(line.trim()) && tokens.length >= 8) {
      const transition = tokens[3] ?? 'C';
      const hasDuration = transition !== 'C' && tokens.length >= 9;
      const tcs = tokens.slice(hasDuration ? 5 : 4, hasDuration ? 9 : 8).map((tc) => timecodeToFrames(tc, rate));
      if (tcs.some((tc) => tc === null)) continue;
      const [srcIn, srcOut, recIn, recOut] = tcs as [number, number, number, number];
      last = {
        number: Number(tokens[0]),
        reel: tokens[1] ?? 'AX',
        channel: tokens[2] ?? 'V',
        transition,
        ...(hasDuration ? { duration: Number(tokens[4]) || 0 } : {}),
        srcIn,
        srcOut,
        recIn,
        recOut,
      };
      events.push(last);
      continue;
    }
    if (/^M2\s/.test(line) && last) {
      const fps = Number(tokens[2]);
      if (Number.isFinite(fps) && fps !== 0) last.speed = fps / rate.nominal;
      continue;
    }
    const comment = /^\*\s*([A-Z ]+?):\s*(.*)$/.exec(line.trim());
    if (comment && last) {
      const key = comment[1];
      const value = comment[2] ?? '';
      if (key === 'FROM CLIP NAME') last.fromName = value;
      else if (key === 'TO CLIP NAME') last.toName = value;
      else if (key === 'SOURCE FILE') last.sourceFile = value;
    }
    const loc = /^\*\s*LOC:\s*(\S+)\s+\S+\s*(.*)$/.exec(line.trim());
    if (loc) {
      const frame = timecodeToFrames(loc[1] ?? '', rate);
      if (frame !== null) markers.push({ frame, name: (loc[2] ?? '').trim() });
    }
  }
  return { events, markers };
}

function eventName(event: ParsedEvent, incoming: boolean): string {
  return (incoming ? event.toName ?? event.fromName : event.fromName) ?? event.sourceFile ?? event.reel;
}

/** Speed from the source and record lengths when no `M2` line says (some tools write it so). */
function impliedSpeed(event: ParsedEvent): number {
  const rec = event.recOut - event.recIn;
  const src = event.srcOut - event.srcIn;
  return rec > 0 && src > 0 && src !== rec ? src / rec : 1;
}

function clipFrom(event: ParsedEvent, name: string, sourceIn: number, duration: number, audio: boolean): InterchangeClip {
  const file = event.sourceFile && !event.sourceFile.endsWith(' (sequence)') ? event.sourceFile : undefined;
  const fileName = file ? file.split(/[\\/]/).pop() ?? file : name;
  return compact({
    type: 'clip' as const,
    name: name.replace(/ \(sequence\)$/, ''),
    media: compact({
      name: fileName,
      url: file && file !== fileName ? file : undefined,
      hasVideo: !audio,
      hasAudio: audio || event.channel.includes('A') || event.channel === 'B',
    }),
    sourceIn,
    duration,
    speed: event.speed ?? impliedSpeed(event),
    enabled: true,
  }) as InterchangeClip;
}

/** Parse a CMX 3600 EDL into the neutral timeline. Throws `EdlError` when it has no events. */
export function readEdl(text: string, options: ReadEdlOptions = {}): InterchangeTimeline {
  const rate = parseRate(text, options);
  const { events, markers: locs } = parseEvents(text, rate);
  if (events.length === 0) throw new EdlError('No EDL events found.');
  const title = /^TITLE:\s*(.*)$/im.exec(text)?.[1]?.trim() || 'EDL';
  const startFrame = Math.min(...events.map((e) => e.recIn));
  const video: InterchangeItem[] = [];
  const audioTracks: InterchangeItem[][] = [[], []];
  const audioCursor = [0, 0];
  let cursor = 0;
  let lastClip: InterchangeClip | null = null;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (!event.channel.includes('V')) {
      const lane = event.channel === 'A2' ? 1 : 0;
      const at = event.recIn - startFrame;
      const items = audioTracks[lane]!;
      if (at > audioCursor[lane]!) items.push({ type: 'gap', duration: at - audioCursor[lane]! });
      const duration = event.recOut - event.recIn;
      items.push(clipFrom(event, eventName(event, false), event.srcIn, duration, true));
      audioCursor[lane] = at + duration;
      continue;
    }
    // The zero-length "from" line of a dissolve pair only names the outgoing clip.
    const next = events[i + 1];
    if (event.transition === 'C' && event.recIn === event.recOut && next && next.number === event.number && next.transition !== 'C') continue;
    const at = event.recIn - startFrame;
    const duration = event.recOut - event.recIn;
    if (event.transition !== 'C' && lastClip && (event.duration ?? 0) > 0) {
      const d = event.duration ?? 0;
      const inOffset = Math.round(d / 2);
      lastClip.duration += inOffset;
      cursor += inOffset;
      video.push({ type: 'transition', name: event.transition === 'D' ? 'dissolve' : 'wipeLeft', inOffset, outOffset: d - inOffset });
      const speed = event.speed ?? 1;
      const clip = clipFrom(event, eventName(event, true), event.srcIn + Math.round(inOffset * speed), duration - inOffset, false);
      video.push(clip);
      lastClip = clip;
      cursor += clip.duration;
      continue;
    }
    if (at > cursor) video.push({ type: 'gap', duration: at - cursor });
    const clip = clipFrom(event, eventName(event, false), event.srcIn, duration, false);
    video.push(clip);
    lastClip = clip;
    cursor = Math.max(cursor, at) + duration;
  }
  const tracks: InterchangeTrack[] = [{ kind: 'video', role: 'base', name: 'V', enabled: true, items: video }];
  audioTracks.forEach((items, index) => {
    if (items.length > 0) tracks.push({ kind: 'audio', role: 'audio', name: index === 0 ? 'A' : 'A2', enabled: true, items });
  });
  const markers: InterchangeMarker[] = locs.map((loc) => ({ frame: loc.frame - startFrame, duration: 0, name: loc.name }));
  return { name: title, rate, startFrame, width: 1920, height: 1080, tracks, markers, captions: [] };
}
