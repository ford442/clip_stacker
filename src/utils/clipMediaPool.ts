/**
 * Shared hidden-<video> decode pool for timeline preview compositors.
 *
 * Both the WebGPU (`TimelinePreviewEngine`) and Canvas2D
 * (`TimelineCanvas2DRenderer`) preview paths seek the same set of source clips
 * to arbitrary `globalTime` positions, so they share one decoder per clip via
 * this pool. Kept free of any GPU / 2D-context dependency so either backend can
 * own it.
 */

import type { Clip } from '../types';

export const SEEK_TOLERANCE_SECONDS = 0.04;

/**
 * Maximum simultaneous hidden-<video> decoders kept alive. Beyond this the pool
 * evicts the least-recently-used decoders (which, because active clips are
 * fetched every frame, are the ones farthest from the playhead) so a long
 * timeline does not accumulate unbounded decoder memory.
 */
export const DEFAULT_MAX_DECODERS = 8;

/**
 * Hidden video elements keyed by clip id — one decoder per source clip, bounded
 * to at most `maxDecoders`. The backing Map's insertion order doubles as the
 * LRU list: `getVideo` re-inserts on access so the most-recently-used entry is
 * always last and the least-recently-used is first.
 */
export class ClipMediaPool {
  private readonly videos = new Map<string, HTMLVideoElement>();

  constructor(private readonly maxDecoders: number = DEFAULT_MAX_DECODERS) {}

  /** Live decoder count. */
  get size(): number {
    return this.videos.size;
  }

  /** Configured decoder cap. */
  get limit(): number {
    return this.maxDecoders;
  }

  getVideo(clip: Clip): HTMLVideoElement {
    const existing = this.videos.get(clip.id);
    if (existing) {
      if (existing.src !== clip.objectUrl) {
        existing.src = clip.objectUrl;
      }
      // Move to the most-recently-used end of the LRU order.
      this.videos.delete(clip.id);
      this.videos.set(clip.id, existing);
      return existing;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.src = clip.objectUrl;
    video.style.cssText =
      'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
    document.body.appendChild(video);
    this.videos.set(clip.id, video);
    return video;
  }

  remove(clipId: string): void {
    const video = this.videos.get(clipId);
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (video.parentElement) video.parentElement.removeChild(video);
    this.videos.delete(clipId);
  }

  destroy(): void {
    for (const clipId of [...this.videos.keys()]) {
      this.remove(clipId);
    }
  }

  pruneExcept(keepIds: ReadonlySet<string>): void {
    for (const clipId of [...this.videos.keys()]) {
      if (!keepIds.has(clipId)) {
        this.remove(clipId);
      }
    }
  }

  /**
   * Evict least-recently-used decoders until at most `maxDecoders` remain, never
   * removing a clip in `protectedIds` (the layers needed for the current frame).
   * If every remaining decoder is protected, stops early.
   */
  enforceBudget(protectedIds: ReadonlySet<string> = new Set()): void {
    if (this.videos.size <= this.maxDecoders) return;
    // Map keys iterate oldest → newest, so this walks LRU → MRU.
    for (const clipId of [...this.videos.keys()]) {
      if (this.videos.size <= this.maxDecoders) break;
      if (protectedIds.has(clipId)) continue;
      this.remove(clipId);
    }
  }

  /** Pause every pooled decoder (idle teardown — stop background buffering). */
  pauseAll(): void {
    for (const video of this.videos.values()) {
      video.pause();
    }
  }
}

export async function seekVideoTo(
  video: HTMLVideoElement,
  time: number,
): Promise<void> {
  const clamped = Math.max(0, time);
  if (Math.abs(video.currentTime - clamped) <= SEEK_TOLERANCE_SECONDS) return;

  video.pause();
  video.currentTime = clamped;

  await new Promise<void>((resolve) => {
    if (Math.abs(video.currentTime - clamped) <= SEEK_TOLERANCE_SECONDS) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
  });
}
