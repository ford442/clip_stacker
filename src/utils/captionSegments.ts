/**
 * Speech-to-text segments → {@link CaptionEntry} cues.
 *
 * Every auto-caption provider ends up here: whatever a model calls its output
 * (`segments`, `chunks`, `utterances`), it is reduced to
 * {@link TranscriptSegment} and mapped by the same pure function, so timing
 * clamps, offsetting and blank-cue filtering behave identically across
 * backends. Kept free of DOM and model specifics — it is the piece the unit
 * tests cover without any WASM or network.
 */

import type { CaptionEntry } from '../types';
import { createCaptionId, MIN_CAPTION_DURATION_SEC } from './subtitles';

/** One model-emitted span of speech, in seconds from the start of the audio. */
export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface SegmentMappingOptions {
  /** Seconds added to every cue, so a slice maps onto the output timeline. */
  timeOffsetSec?: number;
  /** Shortest cue emitted. Defaults to {@link MIN_CAPTION_DURATION_SEC}. */
  minDurationSec?: number;
  /** Id factory — overridden in tests for stable ids. */
  createId?: () => string;
}

/**
 * Whisper emits these bracketed markers for non-speech audio. They are
 * transcription metadata, not something anyone wants burned into a video.
 */
const NON_SPEECH_RE = /^[[(【][^\])】]*[\])】]$/;

/** Collapse runs of spaces/tabs but keep the line breaks a model emitted. */
function tidyText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Map segments to cues: trimmed, blank- and marker-free, offset onto the
 * output timeline, clamped to a sane minimum length and sorted by start time.
 *
 * Segments with non-finite times are dropped rather than repaired — a cue at
 * `NaN` would poison every downstream timing comparison.
 */
export function segmentsToCaptions(
  segments: readonly TranscriptSegment[],
  options: SegmentMappingOptions = {},
): CaptionEntry[] {
  const offset = Number.isFinite(options.timeOffsetSec)
    ? (options.timeOffsetSec as number)
    : 0;
  const minDuration =
    Number.isFinite(options.minDurationSec) && (options.minDurationSec as number) > 0
      ? (options.minDurationSec as number)
      : MIN_CAPTION_DURATION_SEC;
  const createId = options.createId ?? createCaptionId;

  const cues: CaptionEntry[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    const text = tidyText(segment.text ?? '');
    if (text.length === 0 || NON_SPEECH_RE.test(text)) continue;
    if (!Number.isFinite(segment.startSec) || !Number.isFinite(segment.endSec)) continue;

    const startSec = Math.max(0, segment.startSec + offset);
    const endSec = Math.max(startSec + minDuration, segment.endSec + offset);
    cues.push({ id: createId(), startSec, endSec, text });
  }

  return cues.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

/**
 * Merge transcribed cues into an existing track.
 *
 * "Merge" keeps every existing cue and adds the new ones, minus any incoming
 * cue that overlaps an existing one — transcribing a second clip should not
 * double up on a range the user already captioned by hand.
 */
export function mergeCaptions(
  existing: readonly CaptionEntry[],
  incoming: readonly CaptionEntry[],
): CaptionEntry[] {
  const kept = incoming.filter(
    (cue) =>
      !existing.some(
        (other) => cue.startSec < other.endSec && other.startSec < cue.endSec,
      ),
  );
  return [...existing, ...kept].sort(
    (a, b) => a.startSec - b.startSec || a.endSec - b.endSec,
  );
}
