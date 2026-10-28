/**
 * Backward frame source for a reversed clip.
 *
 * A forward decoder cursor reopens from the previous keyframe on every
 * backward step, which makes reverse playback re-decode the whole GOP per
 * frame. This cache decodes one ~1s chunk (from the trim end backward) and
 * serves every source time inside it from memory.
 */

import type { SequentialFrame } from './decoderCursor';

/** How much source time one cached decode covers. */
export const REVERSE_CHUNK_SEC = 1;

const DRAIN_STEP_SEC = 1 / 120;

export interface ReverseCursor {
  frameAt(sourceTimeSec: number): Promise<SequentialFrame | null>;
  close(): void;
}

export function reverseChunkBounds(
  trimStart: number,
  trimEnd: number,
  sourceTime: number,
  chunkSec = REVERSE_CHUNK_SEC,
): { start: number; end: number } {
  const span = Math.max(0, trimEnd - trimStart);
  if (!(span > 0) || span <= chunkSec) {
    return { start: trimStart, end: trimEnd };
  }
  const clamped = Math.min(trimEnd, Math.max(trimStart, sourceTime));
  const fromEnd = Math.max(0, trimEnd - clamped - 1e-6);
  const maxIndex = Math.max(0, Math.ceil(span / chunkSec) - 1);
  const index = Math.min(maxIndex, Math.floor(fromEnd / chunkSec));
  const end = trimEnd - index * chunkSec;
  const start = Math.max(trimStart, end - chunkSec);
  return { start, end: Math.max(start, end) };
}

/** Pull the distinct frames a forward cursor emits across `[start, end)`. */
export async function drainReverseChunk(
  cursor: ReverseCursor,
  start: number,
  end: number,
): Promise<SequentialFrame[]> {
  const frames: SequentialFrame[] = [];
  let lastTs = Number.NEGATIVE_INFINITY;
  const limit = Math.max(start, end - 1e-4);
  for (let t = start; t <= limit + 1e-9; t += DRAIN_STEP_SEC) {
    const frame = await cursor.frameAt(Math.min(t, limit));
    if (!frame) break;
    if (frame.timestamp !== lastTs) {
      frames.push(frame);
      lastTs = frame.timestamp;
    } else {
      frame.close();
    }
  }
  return frames;
}

function frameCovering(frames: SequentialFrame[], sourceTimeSec: number): SequentialFrame | null {
  if (frames.length === 0) return null;
  const targetUs = sourceTimeSec * 1_000_000;
  let match = frames[0]!;
  for (const frame of frames) {
    if (frame.timestamp <= targetUs) match = frame;
    else break;
  }
  return match;
}

interface CachedChunk {
  start: number;
  end: number;
  trimEnd: number;
  frames: SequentialFrame[];
}

/**
 * One decoded chunk per layer key. `openCursor` is called with the chunk's
 * own trim, not the clip's whole window.
 */
export class ReverseChunkCache {
  private readonly chunks = new Map<string, CachedChunk>();

  constructor(
    private readonly openCursor: (
      key: string,
      trimStart: number,
      trimEnd: number,
    ) => Promise<ReverseCursor>,
  ) {}

  async frameAt(
    key: string,
    sourceTime: number,
    trimStart: number,
    trimEnd: number,
  ): Promise<SequentialFrame | null> {
    const bounds = reverseChunkBounds(trimStart, trimEnd, sourceTime);
    let chunk = this.chunks.get(key);
    const same =
      chunk != null &&
      chunk.start === bounds.start &&
      chunk.end === bounds.end &&
      chunk.trimEnd === trimEnd;
    if (!same) {
      this.release(key);
      const cursor = await this.openCursor(key, bounds.start, bounds.end);
      try {
        const frames = await drainReverseChunk(cursor, bounds.start, bounds.end);
        chunk = { start: bounds.start, end: bounds.end, trimEnd, frames };
        this.chunks.set(key, chunk);
      } finally {
        cursor.close();
      }
    }
    const match = frameCovering(chunk!.frames, sourceTime);
    return match ? match.clone() : null;
  }

  release(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    for (const frame of chunk.frames) frame.close();
    this.chunks.delete(key);
  }

  pruneKeys(keep: (key: string) => boolean): void {
    for (const key of [...this.chunks.keys()]) {
      if (!keep(key)) this.release(key);
    }
  }

  destroy(): void {
    for (const key of [...this.chunks.keys()]) this.release(key);
  }
}
