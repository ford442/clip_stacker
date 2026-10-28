import type { Clip, SegmentRequest, SegmentResult } from '../../types';
import type { EditState } from '../editModeCore';
import { planSegmentReplacement, type SegmentMedia } from './segmentReplace';
import { SegmentError, validateSegmentRange } from './extractSegment';

/** The editor operations replaceSegment needs; the app supplies the stores, tests supply fakes. */
export interface ReplaceDeps {
  fetchBlob(url: string): Promise<Blob>;
  /** Read the real media: its length is checked against the segment, not taken from the result record. */
  readMedia(file: File): Promise<{
    durationSec: number;
    objectUrl: string;
    width?: number;
    height?: number;
    hasAudio?: boolean;
  }>;
  revokeObjectUrl(url: string): void;
  getEditState(): EditState;
  /** Applies the edit as ONE undo step. */
  commitEdit(next: EditState): void;
  /** The source clip was cut into pieces: drop it from any A/B group. */
  afterSplit(sourceClip: Clip): void;
  select(clipId: string): void;
}

export type ReplaceOutcome = { ok: true; message: string; clipId: string } | { ok: false; message: string };

function fileNameFor(result: SegmentResult, fallback: string): string {
  if (result.url.startsWith('blob:')) return fallback;
  const last = decodeURIComponent(new URL(result.url).pathname.split('/').pop() ?? '');
  return last || fallback;
}

/**
 * Swap a processed segment back into the timeline: the clip's `[startSec,
 * endSec]` window is replaced by `result`, at the same position, in one undo
 * step. The result is fetched and measured again here — a segment of the wrong
 * length is refused, so nothing after it moves and a later lossless concat of
 * the lane still lines up.
 */
export async function replaceSegment(
  clipId: string,
  request: Pick<SegmentRequest, 'startSec' | 'endSec'>,
  result: SegmentResult,
  deps: ReplaceDeps,
): Promise<ReplaceOutcome> {
  let objectUrl: string | undefined;
  try {
    validateSegmentRange(request.startSec, request.endSec);
    const blob = await deps.fetchBlob(result.url);
    const file = new File([blob], fileNameFor(result, `segment_${clipId}.mp4`), { type: blob.type || 'video/mp4' });
    const info = await deps.readMedia(file);
    objectUrl = info.objectUrl;

    const media: SegmentMedia = {
      file,
      objectUrl: info.objectUrl,
      durationSec: info.durationSec,
      videoWidth: info.width ?? result.width,
      videoHeight: info.height ?? result.height,
      hasAudio: info.hasAudio,
      ...(result.url.startsWith('blob:') ? {} : { remoteUrl: result.url }),
    };
    const outcome = planSegmentReplacement(deps.getEditState(), {
      clipId,
      startSec: request.startSec,
      endSec: request.endSec,
      media,
    });
    if (!outcome.ok) throw new SegmentError(outcome.reason);

    deps.commitEdit(outcome.state);
    if (outcome.splitSourceClip) deps.afterSplit(outcome.splitSourceClip);
    deps.select(outcome.replacedClipId);
    objectUrl = undefined; // owned by the clip now
    return { ok: true, message: outcome.summary, clipId: outcome.replacedClipId };
  } catch (error) {
    if (objectUrl) deps.revokeObjectUrl(objectUrl);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
