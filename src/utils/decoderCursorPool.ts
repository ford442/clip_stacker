/**
 * Keyed pool of forward-only `DecoderFrameCursor`s.
 *
 * Extracted from `TimelineDecoderFrameProvider` so GPU export and the preview
 * worker share one implementation of the three rules that make a forward-only
 * decoder usable as a random-access frame source:
 *
 *  1. A request that goes meaningfully *backward* is a real discontinuity
 *     (loop, scrub, jog) — close the cursor and reopen from the previous sync
 *     sample rather than trying to advance a forward cursor backwards.
 *  2. A cursor that runs past its last frame is freed immediately; the next
 *     request for that key opens fresh.
 *  3. Live cursors are hard-capped like `ClipMediaPool`'s `<video>` budget, so
 *     a 200-clip timeline holds decoders for the *active* layers only.
 *
 * Cursor construction is injectable so tests (and the worker, which owns the
 * clip blobs itself) can supply their own opener.
 */

import { DecoderFrameCursor } from './decoderCursor';

/** Matches ClipMediaPool's <video> element budget so export and preview scale similarly. */
export const DEFAULT_MAX_DECODER_CURSORS = 8;

/**
 * A request more than this far behind the last time served counts as a real
 * discontinuity (loop / backward jump) rather than sub-frame jitter, and
 * triggers reopening the cursor at the new position instead of trying to
 * keep advancing it forward.
 */
export const BACKWARD_JUMP_EPSILON_SEC = 1 / 60;

/** Minimal cursor surface the pool depends on (real `DecoderFrameCursor` satisfies it). */
export interface ForwardFrameCursor {
  frameAt(sourceTimeSec: number): Promise<VideoFrame | null>;
  close(): void;
}

export type CursorOpener = (key: string) => Promise<ForwardFrameCursor>;

interface CursorEntry {
  cursor: ForwardFrameCursor;
  lastSourceTime: number;
}

export class DecoderCursorPool {
  private readonly cursors = new Map<string, CursorEntry>();
  private readonly unsupported = new Set<string>();

  constructor(
    private readonly openCursor: CursorOpener,
    private readonly maxConcurrent: number = DEFAULT_MAX_DECODER_CURSORS,
  ) {}

  /** Live decoder cursor count (for budget instrumentation, mirrors ClipMediaPool.size). */
  get activeCount(): number {
    return this.cursors.size;
  }

  /** True once `key` has been proven undecodable — callers should use their fallback. */
  isUnsupported(key: string): boolean {
    return this.unsupported.has(key);
  }

  /**
   * Frame whose presentation window contains `sourceTimeSec`, or null when the
   * key cannot be decoded at all (caller falls back) or the cursor ran out.
   * The returned frame is caller-owned and must be closed.
   */
  async frameAt(key: string, sourceTimeSec: number): Promise<VideoFrame | null> {
    if (this.unsupported.has(key)) return null;

    let entry = this.cursors.get(key);

    if (entry && sourceTimeSec + BACKWARD_JUMP_EPSILON_SEC < entry.lastSourceTime) {
      entry.cursor.close();
      this.cursors.delete(key);
      entry = undefined;
    }

    if (!entry) {
      if (this.cursors.size >= this.maxConcurrent) this.evictOldest();
      try {
        const cursor = await this.openCursor(key);
        entry = { cursor, lastSourceTime: sourceTimeSec };
        this.cursors.set(key, entry);
      } catch {
        // Codec/container the decoder can't handle — caller falls back to the
        // <video> path for this key for the rest of the session.
        this.unsupported.add(key);
        return null;
      }
    }

    entry.lastSourceTime = sourceTimeSec;
    const frame = await entry.cursor.frameAt(sourceTimeSec);
    if (frame === null) {
      entry.cursor.close();
      this.cursors.delete(key);
    }
    return frame;
  }

  /** Drop the cursor for `key` (e.g. its clip's media changed). Keeps unsupported marks. */
  release(key: string): void {
    this.cursors.get(key)?.cursor.close();
    this.cursors.delete(key);
  }

  /** Drop every cursor (and unsupported mark) whose key fails `keep`. */
  pruneKeys(keep: (key: string) => boolean): void {
    for (const key of [...this.cursors.keys()]) {
      if (!keep(key)) this.release(key);
    }
    for (const key of [...this.unsupported]) {
      if (!keep(key)) this.unsupported.delete(key);
    }
  }

  private evictOldest(): void {
    // Map insertion order: entries are re-requested every frame while their
    // layer is on screen, so the eldest untouched entry is the one whose layer
    // stopped appearing in the plan (map iteration is insertion, not access,
    // order — good enough for a hard cap; exhaustion already frees the common
    // case).
    const oldestKey = this.cursors.keys().next().value;
    if (oldestKey === undefined) return;
    this.release(oldestKey);
  }

  destroy(): void {
    for (const entry of this.cursors.values()) entry.cursor.close();
    this.cursors.clear();
    this.unsupported.clear();
  }
}

/** Default opener: a real `DecoderFrameCursor` over a clip blob and trim window. */
export function blobCursorOpener(
  resolve: (key: string) => { blob: Blob; trimStart: number; trimEnd: number } | null,
): CursorOpener {
  return async (key) => {
    const media = resolve(key);
    if (!media) throw new Error(`no media registered for ${key}`);
    return DecoderFrameCursor.open(media.blob, media.trimStart, media.trimEnd);
  };
}
