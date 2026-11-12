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
 *
 * Export always decodes `clip.file`, never a preview proxy: the proxy is a
 * 960p scrub stream, and the deliverable is encoded from the original at full
 * resolution under every toggle.
 */

import type { Clip } from '../types';
import type { LayerFrameProvider, PreviewClipLayer } from '../composition/previewComposition';
import { DecoderFrameCursor, type DecoderCursorOptions } from './decoderCursor';
import { colorSpaceForOverride } from './sourceColorSpace';
import { cursorStartAt, DecoderCursorPool, DEFAULT_MAX_DECODER_CURSORS } from './decoderCursorPool';
import { ReverseChunkCache } from './reverseFrames';
import { clipIsReversed } from '../timeline/reverseClip';

export { DEFAULT_MAX_DECODER_CURSORS };

function layerKey(layer: PreviewClipLayer, clip: Clip): string {
  // An override decodes differently: a changed one gets its own cursor.
  const base = `${layer.kind}:${layer.clipId}:${layer.timelineIndex}`;
  return clip.colorSpaceOverride ? `${base}:${clip.colorSpaceOverride}` : base;
}

function cursorOptions(clip: Clip, startAt?: number): DecoderCursorOptions {
  return {
    ...(startAt !== undefined ? { startAt } : {}),
    ...(clip.colorSpaceOverride ? { colorSpace: colorSpaceForOverride(clip.colorSpaceOverride) } : {}),
  };
}

export class TimelineDecoderFrameProvider implements LayerFrameProvider {
  private readonly pending = new Map<string, Clip>();
  private readonly pool: DecoderCursorPool;
  private readonly reverseCache: ReverseChunkCache;

  constructor(maxConcurrent: number = DEFAULT_MAX_DECODER_CURSORS) {
    this.pool = new DecoderCursorPool(async (key, sourceTime) => {
      const clip = this.pending.get(key);
      if (!clip) throw new Error(`no clip registered for ${key}`);
      const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
      const startAt = cursorStartAt(sourceTime, clip.trimStart, trimEnd);
      return DecoderFrameCursor.open(clip.file, clip.trimStart, trimEnd, cursorOptions(clip, startAt));
    }, maxConcurrent);
    this.reverseCache = new ReverseChunkCache(async (key, trimStart, trimEnd) => {
      const clip = this.pending.get(key);
      if (!clip) throw new Error(`no clip registered for ${key}`);
      return DecoderFrameCursor.open(clip.file, trimStart, trimEnd, cursorOptions(clip));
    });
  }

  /** Live decoder cursor count (for budget instrumentation, mirrors ClipMediaPool.size). */
  get activeCount(): number {
    return this.pool.activeCount;
  }

  async getFrame(layer: PreviewClipLayer, clip: Clip): Promise<VideoFrame | null> {
    if (clip.kind !== 'video' || clip.stillImage) return null;

    const key = layerKey(layer, clip);
    this.pending.set(key, clip);
    try {
      if (clipIsReversed(clip)) {
        const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
        return (await this.reverseCache.frameAt(
          key,
          layer.sourceTime,
          clip.trimStart,
          trimEnd,
        )) as VideoFrame | null;
      }
      return await this.pool.frameAt(key, layer.sourceTime);
    } finally {
      this.pending.delete(key);
    }
  }

  destroy(): void {
    this.pool.destroy();
    this.reverseCache.destroy();
    this.pending.clear();
  }
}
