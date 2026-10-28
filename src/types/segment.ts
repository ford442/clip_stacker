/**
 * Segment extract / replace workflow (see `utils/segments/`).
 *
 * A *segment* is a window `[startSec, endSec]` of one source file. It is cut
 * out, optionally processed (RIFE, a manual Colab round trip, …) and swapped
 * back in. The processed result has to be exactly as long as the segment, so
 * the timeline never shifts and a later lossless concat stays possible.
 */

export interface SegmentRequest {
  source:
    | { kind: 'drive'; fileId: string }
    | { kind: 'local'; clipId: string }
    | { kind: 'remote'; url: string };
  /** Window start in source-media seconds. */
  startSec: number;
  /** Window end in source-media seconds. */
  endSec: number;
  outputName?: string;
}

export interface SegmentResult {
  /** Where the segment media can be fetched: a Contabo media URL or a `blob:` URL. */
  url: string;
  /** Measured length of the media at `url`; must match `endSec - startSec`. */
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * A Google Drive file kept in the media library as a *reference only*: the
 * bytes stay in Drive and are never downloaded into the browser by default.
 */
export interface DriveMediaItem {
  kind: 'drive';
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
}

/** Where a segment is cut and processed ("Send to processing"). */
export type ProcessingBackendId = 'browser' | 'hf-rife' | 'colab' | 'contabo';

/** What happens to the cut segment before it comes back. */
export type SegmentOperation = 'extract' | 'rife2' | 'rife4';
