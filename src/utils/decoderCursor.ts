/**
 * Sequential per-layer frame cursor for GPU timeline export.
 *
 * Wraps a single `ClipFrameDecoder` (hardware `VideoDecoder`, see
 * `webcodecs-decoder.ts`) and exposes `frameAt(sourceTimeSec)`: it holds the
 * decoded frame whose presentation window brackets the requested time and
 * advances the decoder forward — never seeking — as the caller's requested
 * time increases. This is the piece that lets GPU timeline export skip the
 * `<video>` element seek entirely: export always walks each layer's source
 * time monotonically forward, which is exactly what a decoder cursor is
 * good at and a random-access seek is not.
 */

import { ClipFrameDecoder } from './webcodecs-decoder';

/** Minimal shape the bracketing algorithm needs — real `VideoFrame` satisfies this. */
export interface SequentialFrame {
  /** Presentation timestamp in microseconds (matches `VideoFrame.timestamp`). */
  timestamp: number;
  /** Frame duration in microseconds, when known (matches `VideoFrame.duration`). */
  duration?: number | null;
  close(): void;
  clone(): SequentialFrame;
}

/**
 * Forward-only frame cursor over any sequential async frame source: holds
 * the frame whose presentation window brackets the last requested time,
 * advancing through `source` as requests increase, closing frames it steps
 * past. Generic over the frame type (independent of `VideoDecoder`) so the
 * bracketing logic is unit-testable with fake frames.
 */
export class FrameCursor<F extends SequentialFrame> {
  private current: F | null = null;
  private lookahead: F | null = null;
  private exhausted = false;
  private disposed = false;

  constructor(private readonly source: AsyncIterator<F>) {}

  private async pump(): Promise<F | null> {
    if (this.exhausted) return null;
    const { value, done } = await this.source.next();
    if (done) {
      this.exhausted = true;
      return null;
    }
    return value;
  }

  /**
   * Return a frame (caller-owned; must call `.close()` on it) whose
   * presentation window contains `sourceTimeSec`, held until a later frame's
   * timestamp passes it. Returns null once the source has no more frames —
   * the caller should stop requesting from this cursor at that point.
   *
   * Requests must be non-decreasing; a cursor never seeks backward. Callers
   * that need to jump backward (loop, scrub) should close this cursor and
   * open a fresh one at the new position instead.
   */
  async frameAt(sourceTimeSec: number): Promise<F | null> {
    if (this.disposed) return null;
    if (this.current === null) {
      this.current = await this.pump();
    }

    while (this.current !== null) {
      if (this.lookahead === null && !this.exhausted) {
        this.lookahead = await this.pump();
      }
      // With no lookahead left, the current frame is the last one this
      // source will ever produce — its own duration (when known) bounds how
      // long it stays valid; a request past that end means truly exhausted.
      const boundaryTimeUs = this.lookahead
        ? this.lookahead.timestamp
        : this.exhausted
          ? this.current.timestamp + (this.current.duration ?? 0)
          : Infinity;
      if (sourceTimeSec < boundaryTimeUs / 1_000_000) {
        return this.current.clone() as F;
      }
      this.current.close();
      this.current = this.lookahead;
      this.lookahead = null;
    }
    return null;
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current?.close();
    this.current = null;
    this.lookahead?.close();
    this.lookahead = null;
  }
}

export class DecoderFrameCursor {
  private readonly cursor: FrameCursor<VideoFrame>;
  private readonly decoder: ClipFrameDecoder;

  private constructor(decoder: ClipFrameDecoder) {
    this.decoder = decoder;
    this.cursor = new FrameCursor<VideoFrame>(decoder.frames());
  }

  /** Open a cursor decoding `[trimStart, trimEnd)` of `source` (source-relative seconds). */
  static async open(source: Blob, trimStart: number, trimEnd: number): Promise<DecoderFrameCursor> {
    const decoder = await ClipFrameDecoder.open(source, { trimStart, trimEnd });
    return new DecoderFrameCursor(decoder);
  }

  frameAt(sourceTimeSec: number): Promise<VideoFrame | null> {
    return this.cursor.frameAt(sourceTimeSec);
  }

  close(): void {
    this.cursor.close();
    this.decoder.close();
  }
}
