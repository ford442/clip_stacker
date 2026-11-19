/**
 * SMPTE timecode at the interchange sequence rates, drop-frame included.
 *
 * A project's `timecodeStart` (default `01:00:00:00`) and `timecodeRate`
 * (default `30`, the export grid) place frame 0 of the timeline: EDL record
 * timecodes, OTIO `global_start_time`, FCPXML `tcStart` and the BWF
 * `TimeReference` of exported stems all start there.
 */

import type { TimecodeRateId } from '../types';
import { DEFAULT_PROJECT_TIMECODE } from '../types';
import type { FrameRate } from './rational';

/** Timecode / sequence rates the interchange formats are written at. */
export const TIMECODE_RATES: readonly TimecodeRateId[] = [
  '23.976',
  '24',
  '25',
  '29.97',
  '29.97df',
  '30',
  '50',
  '59.94',
  '59.94df',
  '60',
];

export interface TimecodeRate extends FrameRate {
  id: TimecodeRateId;
  /** Frames per timecode second (24, 25, 30, …): 29.97 counts 30. */
  nominal: number;
  dropFrame: boolean;
  /** Short label (`29.97 DF`). */
  label: string;
}

const RATES: Record<TimecodeRateId, TimecodeRate> = {
  '23.976': { id: '23.976', num: 24000, den: 1001, nominal: 24, dropFrame: false, label: '23.976' },
  '24': { id: '24', num: 24, den: 1, nominal: 24, dropFrame: false, label: '24' },
  '25': { id: '25', num: 25, den: 1, nominal: 25, dropFrame: false, label: '25' },
  '29.97': { id: '29.97', num: 30000, den: 1001, nominal: 30, dropFrame: false, label: '29.97 NDF' },
  '29.97df': { id: '29.97df', num: 30000, den: 1001, nominal: 30, dropFrame: true, label: '29.97 DF' },
  '30': { id: '30', num: 30, den: 1, nominal: 30, dropFrame: false, label: '30' },
  '50': { id: '50', num: 50, den: 1, nominal: 50, dropFrame: false, label: '50' },
  '59.94': { id: '59.94', num: 60000, den: 1001, nominal: 60, dropFrame: false, label: '59.94 NDF' },
  '59.94df': { id: '59.94df', num: 60000, den: 1001, nominal: 60, dropFrame: true, label: '59.94 DF' },
  '60': { id: '60', num: 60, den: 1, nominal: 60, dropFrame: false, label: '60' },
};

/** The export grid (`TIMELINE_EXPORT_FPS`) — the default sequence rate. */
export const DEFAULT_TIMECODE_RATE: TimecodeRateId = DEFAULT_PROJECT_TIMECODE.rate;
export const DEFAULT_TIMECODE_START = DEFAULT_PROJECT_TIMECODE.start;

export function isTimecodeRateId(value: unknown): value is TimecodeRateId {
  return typeof value === 'string' && (TIMECODE_RATES as readonly string[]).includes(value);
}

export function timecodeRate(id: TimecodeRateId | undefined): TimecodeRate {
  return RATES[id ?? DEFAULT_TIMECODE_RATE];
}

/** The closest rate for a frames-per-second value (OTIO / FCPXML rates); null when none is close. */
export function timecodeRateForFps(fps: number, dropFrame = false): TimecodeRate | null {
  const matches = Object.values(RATES).filter((rate) => Math.abs(rate.num / rate.den - fps) < 0.005);
  return matches.find((rate) => rate.dropFrame === dropFrame) ?? matches.find((rate) => !rate.dropFrame) ?? null;
}

/** Frames dropped per minute in drop-frame counting (2 at 29.97, 4 at 59.94). */
function dropPerMinute(rate: TimecodeRate): number {
  return rate.dropFrame ? Math.round(rate.nominal / 15) : 0;
}

/**
 * Frame count → `HH:MM:SS:FF` (`HH:MM:SS;FF` for drop frame). Negative
 * counts clamp to 0; hours wrap at 24 as on a deck.
 */
export function framesToTimecode(frames: number, rate: TimecodeRate): string {
  let f = Math.max(0, Math.round(frames));
  const fps = rate.nominal;
  const drop = dropPerMinute(rate);
  if (drop > 0) {
    const perTenMinutes = fps * 600 - drop * 9;
    const perMinute = fps * 60 - drop;
    const tens = Math.floor(f / perTenMinutes);
    const rem = f % perTenMinutes;
    f += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMinute) : 0);
  }
  const ff = f % fps;
  const totalSeconds = Math.floor(f / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600) % 24;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${drop > 0 ? ';' : ':'}${pad(ff)}`;
}

/** `HH:MM:SS:FF` (`;` or `.` before the frames for drop frame) → frame count; null when malformed. */
export function timecodeToFrames(text: string, rate: TimecodeRate): number | null {
  const match = /^\s*(\d{1,2})[:;.](\d{2})[:;.](\d{2})[:;.,](\d{2,3})\s*$/.exec(text);
  if (!match) return null;
  const [hh, mm, ss, ff] = [match[1], match[2], match[3], match[4]].map(Number) as [number, number, number, number];
  const fps = rate.nominal;
  if (mm > 59 || ss > 59 || ff >= fps) return null;
  const drop = dropPerMinute(rate);
  const totalMinutes = hh * 60 + mm;
  let frames = (hh * 3600 + mm * 60 + ss) * fps + ff;
  if (drop > 0) frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  return frames;
}

/** A project's timecode start as frames (the default `01:00:00:00` when unset or malformed). */
export function timecodeStartFrames(start: string | undefined, rate: TimecodeRate): number {
  return timecodeToFrames(start ?? DEFAULT_TIMECODE_START, rate) ?? (timecodeToFrames(DEFAULT_TIMECODE_START, rate) as number);
}

/** A project's timecode start in seconds (for BWF `TimeReference`). */
export function timecodeStartSeconds(start: string | undefined, rateId: TimecodeRateId | undefined): number {
  const rate = timecodeRate(rateId);
  return (timecodeStartFrames(start, rate) * rate.den) / rate.num;
}

/** Normalize a typed timecode (`1:0:0:0` is rejected; `01:00:00;00` keeps its drop-frame form). */
export function normalizeTimecode(text: string, rate: TimecodeRate): string | null {
  const frames = timecodeToFrames(text, rate);
  return frames === null ? null : framesToTimecode(frames, rate);
}
