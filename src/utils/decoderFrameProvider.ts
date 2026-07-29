/**
 * `LayerFrameProvider` for GPU timeline export — see `previewComposition.ts`
 * for the interface and rationale. Gives each timeline occurrence of a video
 * layer (a base cut, a PiP layer, or one side of a crossfade) its own
 * `DecoderFrameCursor`, so export never seeks a `<video>` element for
 * decoder-eligible clips.
 */

import type { Clip } from '../types';
import type { LayerFrameProvider, PreviewClipLayer } from './previewComposition';
import { DecoderFrameCursor } from './decoderCursor';

/** Matches ClipMediaPool's <video> element budget so export and preview scale similarly. */
export const DEFAULT_MAX_DECODER_CURSORS = 8;

/**
 * A request more than this far behind the last time served counts as a real
 * discontinuity (loop / backward jump) rather than sub-frame jitter, and
 * triggers reopening the cursor at the new position instead of trying to
 * keep advancing it forward.
 */
const BACKWARD_JUMP_EPSILON_SEC = 1 / 60;

interface CursorEntry {
  cursor: DecoderFrameCursor;
  lastSourceTime: number;
}

function layerKey(layer: PreviewClipLayer): string {
  return `${layer.kind}:${layer.clipId}:${layer.timelineIndex}`;
}

export class TimelineDecoderFrameProvider implements LayerFrameProvider {
  private readonly cursors = new Map<string, CursorEntry>();
  private readonly unsupported = new Set<string>();

  constructor(private readonly maxConcurrent: number = DEFAULT_MAX_DECODER_CURSORS) {}

  /** Live decoder cursor count (for budget instrumentation, mirrors ClipMediaPool.size). */
  get activeCount(): number {
    return this.cursors.size;
  }

  async getFrame(layer: PreviewClipLayer, clip: Clip): Promise<VideoFrame | null> {
    if (clip.kind !== 'video' || clip.stillImage) return null;

    const key = layerKey(layer);
    if (this.unsupported.has(key)) return null;

    let entry = this.cursors.get(key);

    // Real discontinuity (loop / backward jump) — the forward-only cursor
    // can't serve this; reopen fresh at the new position.
    if (entry && layer.sourceTime + BACKWARD_JUMP_EPSILON_SEC < entry.lastSourceTime) {
      entry.cursor.close();
      this.cursors.delete(key);
      entry = undefined;
    }

    if (!entry) {
      if (this.cursors.size >= this.maxConcurrent) {
        this.evictOldest();
      }
      const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
      try {
        const cursor = await DecoderFrameCursor.open(clip.file, clip.trimStart, trimEnd);
        entry = { cursor, lastSourceTime: layer.sourceTime };
        this.cursors.set(key, entry);
      } catch {
        // Codec/container the decoder can't handle — caller falls back to
        // the <video> seek path for this layer for the rest of the render.
        this.unsupported.add(key);
        return null;
      }
    }

    entry.lastSourceTime = layer.sourceTime;
    const frame = await entry.cursor.frameAt(layer.sourceTime);
    if (frame === null) {
      // Decoder exhausted this occurrence (requested past its last frame) —
      // free it now; a later request for the same key opens fresh.
      entry.cursor.close();
      this.cursors.delete(key);
    }
    return frame;
  }

  private evictOldest(): void {
    // Map insertion order: entries are re-requested every frame while their
    // layer is on screen, so the eldest untouched entry is the one whose
    // layer stopped appearing in the plan (map iteration is insertion, not
    // access, order — good enough for a hard cap, exhaustion already frees
    // the common case).
    const oldestKey = this.cursors.keys().next().value;
    if (oldestKey === undefined) return;
    this.cursors.get(oldestKey)?.cursor.close();
    this.cursors.delete(oldestKey);
  }

  destroy(): void {
    for (const entry of this.cursors.values()) entry.cursor.close();
    this.cursors.clear();
    this.unsupported.clear();
  }
}
