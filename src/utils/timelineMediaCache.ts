import type { Clip } from '../types';
import { extractThumbnails } from './media';
import { extractWaveformPeaks } from './waveform';

const thumbnailCache = new Map<string, string[]>();
const waveformCache = new Map<string, Float32Array>();

const thumbControllers = new Map<string, AbortController>();
const waveControllers = new Map<string, AbortController>();

function effectiveDur(clip: Clip): number {
  const end = Number.isNaN(clip.trimEnd) ? clip.duration : clip.trimEnd;
  return Math.max(0.1, end - clip.trimStart);
}

export function getCachedThumbnails(clipId: string): string[] | undefined {
  return thumbnailCache.get(clipId);
}

export function getCachedWaveform(clipId: string): Float32Array | undefined {
  return waveformCache.get(clipId);
}

export function clearTimelineMediaCache(): void {
  thumbnailCache.clear();
  waveformCache.clear();
  for (const controller of thumbControllers.values()) controller.abort();
  for (const controller of waveControllers.values()) controller.abort();
  thumbControllers.clear();
  waveControllers.clear();
}

export function cancelTimelineMediaForClip(clipId: string): void {
  thumbControllers.get(clipId)?.abort();
  thumbControllers.delete(clipId);
  waveControllers.get(clipId)?.abort();
  waveControllers.delete(clipId);
}

export function requestTimelineThumbnails(
  clip: Clip,
  onComplete: (clipId: string, thumbs: string[]) => void,
): void {
  if (clip.kind !== 'video') return;

  const cached = thumbnailCache.get(clip.id);
  if (cached) {
    onComplete(clip.id, cached);
    return;
  }

  if (thumbControllers.has(clip.id)) return;

  const controller = new AbortController();
  thumbControllers.set(clip.id, controller);

  const dur = effectiveDur(clip);
  const count = Math.max(2, Math.min(8, Math.ceil(dur / 3)));

  extractThumbnails(
    clip.objectUrl,
    clip.duration,
    clip.trimStart,
    clip.trimEnd,
    count,
    { signal: controller.signal },
  )
    .then((thumbs) => {
      if (controller.signal.aborted) return;
      thumbnailCache.set(clip.id, thumbs);
      onComplete(clip.id, thumbs);
    })
    .catch((err: unknown) => {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      thumbnailCache.set(clip.id, []);
      onComplete(clip.id, []);
    })
    .finally(() => {
      if (thumbControllers.get(clip.id) === controller) {
        thumbControllers.delete(clip.id);
      }
    });
}

export function requestTimelineWaveform(
  clip: Clip,
  onComplete: (clipId: string, peaks: Float32Array) => void,
): void {
  if (clip.kind !== 'audio') return;

  const cached = waveformCache.get(clip.id);
  if (cached) {
    onComplete(clip.id, cached);
    return;
  }

  if (waveControllers.has(clip.id)) return;

  const controller = new AbortController();
  waveControllers.set(clip.id, controller);

  extractWaveformPeaks(clip.objectUrl, 120, { signal: controller.signal })
    .then((peaks) => {
      if (controller.signal.aborted) return;
      waveformCache.set(clip.id, peaks);
      onComplete(clip.id, peaks);
    })
    .catch((err: unknown) => {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      waveformCache.set(clip.id, new Float32Array(0));
      onComplete(clip.id, new Float32Array(0));
    })
    .finally(() => {
      if (waveControllers.get(clip.id) === controller) {
        waveControllers.delete(clip.id);
      }
    });
}

/** Clip indices that need transition UI when only the left neighbor is visible. */
export function orphanTransitionIndices(
  visibleIndices: ReadonlySet<number>,
  clipCount: number,
  hasTransition: (index: number) => boolean,
): number[] {
  const orphans: number[] = [];
  for (let index = 1; index < clipCount; index++) {
    if (visibleIndices.has(index)) continue;
    if (!visibleIndices.has(index - 1)) continue;
    if (!hasTransition(index)) continue;
    orphans.push(index);
  }
  return orphans;
}
