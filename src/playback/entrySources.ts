/**
 * One schedule entry → the `AudioBufferSourceNode`s that play it. The
 * decoded / remapped buffer holds exactly ONE cycle; a looped clip replays
 * it back to back, so there is one source per remaining cycle rather than
 * one long source spanning the whole (multiplied) entry.
 */

import type { AudioScheduleEntry } from '../audio/schedule';
import { applyGainEnvelope, applyPanEnvelope } from '../audio/gainEnvelope';

export interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
  entry: AudioScheduleEntry;
  /** AudioContext time when this source was scheduled to start. */
  when: number;
  /**
   * Elapsed time (seconds) since `entry.timelineStart` at schedule start —
   * spans the WHOLE looped entry, not just this source's own cycle. Fades
   * and volume/pan automation are authored across the full looped duration
   * (same domain as the Inspector's automation editor), so they're sampled
   * from this global position rather than resetting at each loop boundary;
   * a source's own cycle only bounds `playDuration` (how long it plays).
   */
  clipElapsed: number;
  playDuration: number;
}

/** Where and how long one cycle of an entry plays. */
export interface EntryCycle {
  /** AudioContext start time. */
  when: number;
  /** Offset into the single-cycle buffer (seconds of source). */
  bufferOffset: number;
  /** Timeline seconds this source plays. */
  playDuration: number;
  /** Source seconds this source plays (`playDuration × rate`). */
  playDurationSource: number;
  /** See {@link ActiveSource.clipElapsed}. */
  globalClipElapsed: number;
  rate: number;
}

/** Playback rate of the buffer: 1 for a pre-remapped buffer. */
export function entryBufferRate(entry: AudioScheduleEntry): number {
  if (entry.rateRemap) return 1;
  return Number.isFinite(entry.playbackRate) && entry.playbackRate > 0 ? entry.playbackRate : 1;
}

/**
 * The cycles of `entry` still to play from timeline time `globalTime`, with
 * context time `now` at `globalTime`. Pure: clamps to the decoded samples
 * so nothing is scheduled past the buffer.
 */
export function planEntryCycles(
  entry: AudioScheduleEntry,
  bufferDuration: number,
  globalTime: number,
  now: number,
): EntryCycle[] {
  const rate = entryBufferRate(entry);
  const maxOffset = Math.max(0, bufferDuration - 1e-4);
  // Fades and volume/pan automation are authored across the WHOLE looped
  // span, so they are sampled from the global (unwrapped) elapsed time —
  // this also confines fadeIn to the first cycle and fadeOut to the last.
  const globalClipElapsed = Math.max(0, globalTime - entry.timelineStart);
  const cycles: EntryCycle[] = [];
  for (let cycleIndex = 0; cycleIndex < entry.loopCount; cycleIndex++) {
    const cycleStart = entry.timelineStart + cycleIndex * entry.cycleDuration;
    const cycleEnd = cycleStart + entry.cycleDuration;
    if (cycleEnd <= globalTime + 1e-4) continue;

    // Cycle-local elapsed indexes into the single-cycle decoded buffer.
    const cycleLocalElapsed = Math.max(0, globalTime - cycleStart);
    const remainingTimeline = entry.cycleDuration - cycleLocalElapsed;
    if (remainingTimeline <= 1e-4) continue;

    const bufferOffset = entry.bufferOffset + cycleLocalElapsed * rate;
    if (bufferOffset >= maxOffset) continue;
    const remainingSource = maxOffset - bufferOffset;
    const playDuration = Math.min(remainingTimeline, remainingSource / rate);
    if (playDuration <= 1e-4) continue;

    cycles.push({
      when: cycleStart > globalTime ? now + (cycleStart - globalTime) : now,
      bufferOffset,
      playDuration,
      playDurationSource: playDuration * rate,
      globalClipElapsed,
      rate,
    });
  }
  return cycles;
}

/**
 * Build source → gain → (panner) → destination for one cycle and start it.
 * Returns null when the source refuses to start. `onEnded` runs after the
 * nodes are disconnected.
 */
export function startEntrySource(
  ctx: AudioContext,
  buffer: AudioBuffer,
  entry: AudioScheduleEntry,
  cycle: EntryCycle,
  duckedVolume: number,
  destination: AudioNode,
  onEnded: (active: ActiveSource) => void,
): ActiveSource | null {
  const { when, playDuration, globalClipElapsed } = cycle;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = cycle.rate;

  const gain = ctx.createGain();
  applyGainEnvelope(
    gain.gain,
    { ...entry, volume: duckedVolume },
    when,
    playDuration,
    globalClipElapsed,
    ctx.currentTime,
  );

  let panner: StereoPannerNode | null = null;
  if (typeof ctx.createStereoPanner === 'function') {
    panner = ctx.createStereoPanner();
    applyPanEnvelope(
      panner.pan,
      entry.panAutomation,
      when,
      playDuration,
      globalClipElapsed,
      ctx.currentTime,
      entry.duration,
    );
    source.connect(gain);
    gain.connect(panner);
    panner.connect(destination);
  } else {
    source.connect(gain);
    gain.connect(destination);
  }

  try {
    source.start(when, cycle.bufferOffset, cycle.playDurationSource);
  } catch {
    return null;
  }

  const active: ActiveSource = {
    source,
    gain,
    panner,
    entry,
    when,
    clipElapsed: globalClipElapsed,
    playDuration,
  };
  source.onended = () => {
    try {
      source.disconnect();
      gain.disconnect();
      panner?.disconnect();
    } catch {
      // ignore
    }
    onEnded(active);
  };
  return active;
}
