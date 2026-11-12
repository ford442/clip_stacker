import type { Keyframe } from '../timeline/keyframes';
import { nestedInstanceId } from '../timeline/sequenceResolve';
import type { AudioScheduleEntry } from './scheduleEntry';

/**
 * Nested-sequence audio: the inner schedule, cut to the sequence clip's
 * in / out window and moved onto the parent timeline.
 *
 * The inner schedule is built by `buildAudioSchedule` on the sequence's own
 * flattened clips and lanes, so trims, transitions, mute and nested
 * sequences inside it already apply. Each entry then:
 *
 * - is windowed to `[inPoint, inPoint + duration)` of the sequence's time
 *   (its buffer offset, automation and fades move with a cut start; a looped
 *   entry that is cut is split into one entry per cycle first, since a cut
 *   cannot be expressed inside a loop);
 * - moves to `placementStart + (t − inPoint)`;
 * - gets a namespaced clip id, so its decoded / processed buffers are keyed
 *   per instance;
 * - takes the sequence clip's volume and mixes into the **parent** lane's bus
 *   (the lane holding the sequence clip — its FX, duck and mute apply).
 *
 * Mixer rows only: the media engine sees more entries, not a new mixer.
 */

/** Where a sequence clip sits on the parent timeline, and how it is mixed. */
export interface NestedAudioWindow {
  /** The sequence clip's id (the namespace for its entries). */
  parentClipId: string;
  /** Parent output time the sequence clip starts at. */
  placementStart: number;
  /** Sequence time shown at `placementStart` (the clip's trim start). */
  inPoint: number;
  /** Output duration of the sequence clip. */
  duration: number;
  /** The sequence clip's linear volume. */
  volume: number;
  /** Lane routing of the parent lane (`trackId` / `laneDuck`). */
  lane: Pick<AudioScheduleEntry, 'trackId' | 'laneDuck'>;
}

const EPSILON = 1e-6;

function bufferRate(entry: AudioScheduleEntry): number {
  if (entry.rateRemap) return 1;
  return Number.isFinite(entry.playbackRate) && entry.playbackRate > 0 ? entry.playbackRate : 1;
}

function shiftKeyframes(frames: Keyframe[] | undefined, by: number): Keyframe[] | undefined {
  if (!frames || frames.length === 0 || by === 0) return frames;
  return frames.map((frame) => ({ ...frame, t: frame.t - by }));
}

/** One entry per loop cycle (automation and fades stay on their own cycles). */
function splitCycles(entry: AudioScheduleEntry): AudioScheduleEntry[] {
  if (entry.loopCount <= 1) return [entry];
  const cycles: AudioScheduleEntry[] = [];
  for (let k = 0; k < entry.loopCount; k++) {
    const offset = k * entry.cycleDuration;
    const cycle: AudioScheduleEntry = {
      ...entry,
      timelineStart: entry.timelineStart + offset,
      duration: entry.cycleDuration,
      loopCount: 1,
      audioFadeIn: k === 0 ? entry.audioFadeIn : 0,
      audioFadeOut: k === entry.loopCount - 1 ? entry.audioFadeOut : 0,
    };
    const volume = shiftKeyframes(entry.volumeAutomation, offset);
    const pan = shiftKeyframes(entry.panAutomation, offset);
    if (volume) cycle.volumeAutomation = volume;
    if (pan) cycle.panAutomation = pan;
    cycles.push(cycle);
  }
  return cycles;
}

/** `entry` cut to `[from, to)` (sequence time), or null when nothing is left. */
function cutEntry(entry: AudioScheduleEntry, from: number, to: number): AudioScheduleEntry | null {
  const start = entry.timelineStart;
  const end = start + entry.duration;
  const cutStart = Math.max(start, from);
  const cutEnd = Math.min(end, to);
  if (cutEnd - cutStart <= EPSILON) return null;
  const head = cutStart - start;
  const tail = end - cutEnd;
  if (head <= EPSILON && tail <= EPSILON) return entry;

  const duration = cutEnd - cutStart;
  const cut: AudioScheduleEntry = {
    ...entry,
    timelineStart: cutStart,
    duration,
    cycleDuration: duration,
    bufferOffset: entry.bufferOffset + head * bufferRate(entry),
    // A fade the cut runs through ends where it did; one cut away is gone.
    audioFadeIn: Math.max(0, entry.audioFadeIn - head),
    audioFadeOut: Math.max(0, entry.audioFadeOut - tail),
  };
  const volume = shiftKeyframes(entry.volumeAutomation, head);
  const pan = shiftKeyframes(entry.panAutomation, head);
  if (volume) cut.volumeAutomation = volume;
  if (pan) cut.panAutomation = pan;
  return cut;
}

/**
 * The inner schedule of a sequence clip as parent-timeline entries. `inner`
 * is in the nested sequence's time.
 */
export function placeNestedEntries(
  inner: AudioScheduleEntry[],
  window: NestedAudioWindow,
): AudioScheduleEntry[] {
  const from = window.inPoint;
  const to = window.inPoint + window.duration;
  const shift = window.placementStart - window.inPoint;
  const out: AudioScheduleEntry[] = [];
  for (const entry of inner) {
    const end = entry.timelineStart + entry.duration;
    if (end <= from + EPSILON || entry.timelineStart >= to - EPSILON) continue;
    const needsCut = entry.timelineStart < from - EPSILON || end > to + EPSILON;
    const pieces = needsCut ? splitCycles(entry) : [entry];
    for (const piece of pieces) {
      const cut = cutEntry(piece, from, to);
      if (!cut) continue;
      const placed: AudioScheduleEntry = {
        ...cut,
        clipId: nestedInstanceId(window.parentClipId, cut.clipId),
        timelineStart: cut.timelineStart + shift,
        volume: cut.volume * window.volume,
      };
      // A volume curve replaces `volume`, so the sequence clip's gain scales it.
      if (cut.volumeAutomation && window.volume !== 1) {
        placed.volumeAutomation = cut.volumeAutomation.map((frame) => ({
          ...frame,
          value: frame.value * window.volume,
        }));
      }
      delete placed.trackId;
      delete placed.laneDuck;
      Object.assign(placed, window.lane);
      out.push(placed);
    }
  }
  return out;
}
