import type { Clip, Project, SerializedClip } from '../../types';
import type { RemoteProjectLoadProgressEvent } from './types';

export function clampUnitProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress));
}

export function emitRemoteProjectLoadProgress(
  onProgress: ((event: RemoteProjectLoadProgressEvent) => void) | undefined,
  event: RemoteProjectLoadProgressEvent,
): void {
  if (!onProgress) return;
  onProgress({
    ...event,
    progress: typeof event.progress === 'number' ? clampUnitProgress(event.progress) : null,
  });
}

export function hasRestorableRemoteMedia(savedClip: SerializedClip): boolean {
  return Boolean(savedClip.sourceMediaDataUrl || savedClip.sourceMediaUrl);
}

/**
 * Pick the media source URL for a saved clip, preferring the field that
 * matches the project's `mediaMode` so a stale field left over from an
 * earlier save (e.g. embed -> remote without clearing the data URL) doesn't
 * silently win. Falls back to whichever field is present — both for clips
 * that took a different path than the project's overall mode (e.g. an
 * oversized clip uploaded remotely while the rest of the project was
 * embedded) and for older project files saved before `mediaMode` was
 * recorded.
 */
export function selectMediaSource(
  savedClip: SerializedClip,
  mediaMode: Project['mediaMode'],
): string | undefined {
  if (mediaMode === 'remote') {
    return savedClip.sourceMediaUrl ?? savedClip.sourceMediaDataUrl;
  }
  return savedClip.sourceMediaDataUrl ?? savedClip.sourceMediaUrl;
}

export function countRemoteProjectDownloads(project: Project, clips: Clip[]): number {
  if (!Array.isArray(project.clips)) return 0;
  const byName = new Map(clips.map((clip) => [clip.file.name, clip]));
  return project.clips.reduce((count, savedClip) => {
    if (byName.has(savedClip.fileName) || !hasRestorableRemoteMedia(savedClip)) return count;
    return count + 1;
  }, 0);
}

export function buildRemoteDownloadStage(index: number, total: number, fileName: string): string {
  return `Downloading clip ${index} of ${total}: ${fileName}`;
}

export function calculateRemoteDownloadProgress(
  clipIndex: number,
  clipCount: number,
  clipProgress: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  if (clipCount <= 0) return clampUnitProgress(rangeEnd);
  const completed = (clipIndex - 1 + clampUnitProgress(clipProgress)) / clipCount;
  return rangeStart + completed * Math.max(0, rangeEnd - rangeStart);
}
