/**
 * `LayerFrameProvider` for GPU timeline export — see `previewComposition.ts`
 * for the interface and rationale. Gives each timeline occurrence of a video
 * layer (a base cut, a PiP layer, or one side of a crossfade) its own
 * forward-only decoder cursor, so export never seeks a `<video>` element for
 * decoder-eligible clips.
 *
 * The cursor lifecycle (backward-jump reopen, exhaustion, budget cap) lives in
 * `DecoderCursorPool`, shared with the preview worker so preview and export
 * cannot drift apart again.
 */

import type { Clip } from '../types';
import type { LayerFrameProvider, PreviewClipLayer } from './previewComposition';
import { DecoderFrameCursor } from './decoderCursor';
import { DecoderCursorPool, DEFAULT_MAX_DECODER_CURSORS } from './decoderCursorPool';

export { DEFAULT_MAX_DECODER_CURSORS };

function layerKey(layer: PreviewClipLayer): string {
  return `${layer.kind}:${layer.clipId}:${layer.timelineIndex}`;
}

export class TimelineDecoderFrameProvider implements LayerFrameProvider {
  private readonly pending = new Map<string, Clip>();
  private readonly pool: DecoderCursorPool;

  constructor(maxConcurrent: number = DEFAULT_MAX_DECODER_CURSORS) {
    this.pool = new DecoderCursorPool(async (key) => {
      const clip = this.pending.get(key);
      if (!clip) throw new Error(`no clip registered for ${key}`);
      const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
      return DecoderFrameCursor.open(clip.file, clip.trimStart, trimEnd);
    }, maxConcurrent);
  }

  /** Live decoder cursor count (for budget instrumentation, mirrors ClipMediaPool.size). */
  get activeCount(): number {
    return this.pool.activeCount;
  }

  async getFrame(layer: PreviewClipLayer, clip: Clip): Promise<VideoFrame | null> {
    if (clip.kind !== 'video' || clip.stillImage) return null;

    const key = layerKey(layer);
    this.pending.set(key, clip);
    try {
      return await this.pool.frameAt(key, layer.sourceTime);
    } finally {
      this.pending.delete(key);
    }
  }

  destroy(): void {
    this.pool.destroy();
    this.pending.clear();
  }
}
