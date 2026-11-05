import type { Track } from '../types';
import { cloneTracks } from './trackBasics';

/**
 * Text overlays that should be drawn: every overlay not placed on a muted text
 * lane. Overlays with no lane placement are always visible, so projects that
 * never created a titles lane behave exactly as before.
 */
export function visibleTextOverlays<T extends { id: string }>(
  tracks: Track[],
  overlays: T[],
): T[] {
  const hidden = new Set(
    tracks
      .filter((t) => t.kind === 'text' && t.muted)
      .flatMap((t) => t.items.map((i) => i.clipId)),
  );
  if (hidden.size === 0) return overlays;
  return overlays.filter((overlay) => !hidden.has(overlay.id));
}

/** Place a text overlay on a titles lane at an output time. */
export function placeTextOverlayOnTrack(
  tracks: Track[],
  overlayId: string,
  trackId: string,
  startTime: number,
): Track[] {
  const target = tracks.find((t) => t.id === trackId);
  if (!target || target.kind !== 'text' || target.locked) return tracks;
  const next = cloneTracks(tracks).map((track) =>
    track.kind === 'text'
      ? { ...track, items: track.items.filter((i) => i.clipId !== overlayId) }
      : track,
  );
  const nextTarget = next.find((t) => t.id === trackId)!;
  nextTarget.items.push({ clipId: overlayId, startTime: Math.max(0, startTime) });
  nextTarget.items.sort((a, b) => a.startTime - b.startTime);
  return next;
}

/** Drop a text overlay's placement from every titles lane (overlay deleted). */
export function removeTextOverlayFromTracks(
  tracks: Track[],
  overlayId: string,
): Track[] {
  if (!tracks.some((t) => t.kind === 'text' && t.items.some((i) => i.clipId === overlayId))) {
    return tracks;
  }
  return tracks.map((track) =>
    track.kind === 'text'
      ? { ...track, items: track.items.filter((i) => i.clipId !== overlayId) }
      : track,
  );
}
