/**
 * Preview proxies: plan + profile.
 *
 * A proxy is a cheap mezzanine of a camera file — long-GOP H.264, short side
 * ≤ 960, the source frame rate capped at 30 — that scrub, playback and
 * stabilization analysis read instead of the original. Export, Force FFmpeg
 * and anything that writes the deliverable always open `clip.file`.
 *
 * Everything in this module is pure. The encode lives in `proxyEncoder.ts`,
 * the queue in `useProxyBuilder.ts`, the runtime state in `store/proxyStore.ts`.
 */

import type { Clip, ClipProxy } from '../types';

/**
 * The one proxy profile. A constant, not a codec panel: a new profile gets a
 * new id, and lives beside this one under a different store key.
 */
export const PROXY_PROFILE = Object.freeze({
  id: 'h264-960-v1',
  /** Short side of the proxy picture, in pixels. */
  shortSide: 960,
  /** Frame-rate ceiling. Sources below it keep their own rate — frames are never invented. */
  maxFps: 30,
  /** Fixed target bitrate (bits/s) — enough for a clean 960p scrub image. */
  bitrate: 4_000_000,
  /** Seconds between keyframes. Long GOP; backward scrubs reopen from the previous one. */
  keyframeIntervalSec: 2,
});

export type ProxyProfile = typeof PROXY_PROFILE;

/** Store key for a proxy: `(sourceHash, profile)`. */
export function proxyStoreKey(sourceHash: string, profileId: string = PROXY_PROFILE.id): string {
  return `proxy/${profileId}/${sourceHash}`;
}

/** Store key for a clip's ready proxy metadata, or null when it has none. */
export function clipProxyKey(clip: Pick<Clip, 'proxy'>): string | null {
  return clip.proxy ? proxyStoreKey(clip.proxy.hash, clip.proxy.profile) : null;
}

/** Proxy picture size: short side scaled to `shortSide`, aspect kept, even dimensions (4:2:0). */
export function proxyDimensions(
  sourceWidth: number,
  sourceHeight: number,
  shortSide: number = PROXY_PROFILE.shortSide,
): { width: number; height: number } {
  const w = Math.max(2, Math.round(sourceWidth));
  const h = Math.max(2, Math.round(sourceHeight));
  const scale = Math.min(1, shortSide / Math.min(w, h));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * scale), height: even(h * scale) };
}

export type ProxyPlan =
  | { ok: true; width: number; height: number; profile: ProxyProfile }
  | { ok: false; reason: string };

/**
 * Decide whether a clip gets a proxy and at what size. Audio-only clips,
 * stills and sources already at or under the proxy size get none — decoding
 * those originals is no more expensive than decoding a proxy would be.
 */
export function planProxy(
  clip: Pick<Clip, 'kind' | 'stillImage' | 'videoWidth' | 'videoHeight'>,
  profile: ProxyProfile = PROXY_PROFILE,
): ProxyPlan {
  if (clip.kind !== 'video') return { ok: false, reason: 'audio-only clips get no proxy' };
  if (clip.stillImage) return { ok: false, reason: 'stills get no proxy' };
  const w = clip.videoWidth ?? 0;
  const h = clip.videoHeight ?? 0;
  if (!(w > 0 && h > 0)) return { ok: false, reason: 'source dimensions unknown' };
  if (Math.min(w, h) <= profile.shortSide) {
    return { ok: false, reason: 'source is already preview-sized' };
  }
  return { ok: true, ...proxyDimensions(w, h, profile.shortSide), profile };
}

/**
 * Frame-rate cap without inventing frames: walks source timestamps and keeps
 * a frame once it reaches the next slot on a `1 / maxFps` grid. A 24 fps
 * source keeps every frame; a 60 fps source keeps every other one.
 */
export class ProxyFrameSelector {
  private nextSlotSec = 0;
  private readonly intervalSec: number;

  constructor(maxFps: number = PROXY_PROFILE.maxFps) {
    this.intervalSec = 1 / Math.max(1, maxFps);
  }

  /** True when the frame at `timestampSec` should be encoded. */
  accept(timestampSec: number): boolean {
    // Half-millisecond slack absorbs timescale rounding (29.97 vs a 1/30 grid).
    if (timestampSec + 5e-4 < this.nextSlotSec) return false;
    // Re-anchor on the frame rather than the grid so a slow source never
    // accumulates a debt of "missed" slots and starts dropping frames.
    this.nextSlotSec = Math.max(this.nextSlotSec + this.intervalSec, timestampSec + this.intervalSec * 0.5);
    return true;
  }
}

/** Build the serializable proxy record stamped onto a clip once its proxy is stored. */
export function makeClipProxy(
  sourceHash: string,
  width: number,
  height: number,
  profile: ProxyProfile = PROXY_PROFILE,
): ClipProxy {
  return { profile: profile.id, hash: sourceHash, width, height };
}

/** Where a preview layer's bytes come from. */
export type PreviewMediaSource = 'proxy' | 'original';

export interface ResolvedPreviewMedia {
  blob: Blob;
  objectUrl: string;
  source: PreviewMediaSource;
}

/** The subset of proxy-store state preview resolution needs. */
export interface ProxyLookup {
  enabled: boolean;
  ready: Readonly<Record<string, { blob: Blob; objectUrl: string } | undefined>>;
}

/**
 * Pick the bytes the live preview decodes for `clip`: its proxy when proxies
 * are enabled and one is ready, the original otherwise. Export never calls
 * this — the deliverable always reads `clip.file`.
 */
export function resolvePreviewMedia(clip: Clip, lookup: ProxyLookup): ResolvedPreviewMedia {
  if (lookup.enabled) {
    const key = clipProxyKey(clip);
    const ready = key ? lookup.ready[key] : undefined;
    if (ready) return { blob: ready.blob, objectUrl: ready.objectUrl, source: 'proxy' };
  }
  return { blob: clip.file, objectUrl: clip.objectUrl, source: 'original' };
}

/** Library badge state for a clip. */
export type ProxyBadge = 'original' | 'proxy' | 'building';

export function proxyBadgeFor(
  clip: Clip,
  state: { building: Readonly<Record<string, unknown>>; ready: ProxyLookup['ready'] },
): ProxyBadge {
  if (state.building[clip.id]) return 'building';
  const key = clipProxyKey(clip);
  return key && state.ready[key] ? 'proxy' : 'original';
}
