/**
 * The preview worker's side of the frame cache: keys for the frames it
 * draws (`previewFrameKey`) from the media it decodes, fingerprinted as it
 * arrives (`clip-media`). A clip whose bytes are not fingerprinted yet — or
 * that the worker does not decode itself (a `<video>` fallback layer) — has
 * no key, so its frames are simply not cached.
 */

import type { Clip } from '../types';
import type { PreviewCompositionPlan } from '../composition/previewCompositionTypes';
import type { FinishingSettings } from '../finishing/finishing';
import type { ColorManagementSettings } from '../finishing/colorManagement';
import { fingerprintMediaCached } from '../project/mediaStore';
import { BUILD_ID } from '../utils/buildId';
import { previewFrameKey } from './previewFrameCache';
import { PREVIEW_CACHE_FPS } from '../composition/previewCacheGrid';
import type { PreviewMediaSource } from '../media/proxyMedia';

/** Snap a preview time to the cache's frame grid (the export's 30 fps). */
export function snapToCacheGrid(seconds: number): number {
  return Math.round(seconds * PREVIEW_CACHE_FPS) / PREVIEW_CACHE_FPS;
}

/** The frame number of a (snapped) preview time. */
export function cacheFrameNumber(seconds: number): number {
  return Math.round(seconds * PREVIEW_CACHE_FPS);
}

export interface WorkerKeyInput {
  plan: PreviewCompositionPlan;
  clipsById: ReadonlyMap<string, Clip>;
  finishing: FinishingSettings | undefined;
  colorManagement: ColorManagementSettings | undefined;
  displayHdr: boolean;
}

export class WorkerFrameKeys {
  private readonly fingerprints = new Map<Blob, string>();

  constructor(
    /** The bytes the worker decodes for a clip id, if it holds any. */
    private readonly mediaFor: (clipId: string) => { blob: Blob; source: PreviewMediaSource } | undefined,
  ) {}

  /** Start fingerprinting newly received media (keys need it; until then frames are uncached). */
  noteMedia(blob: Blob): void {
    if (this.fingerprints.has(blob) || blob.size === 0) return;
    void fingerprintMediaCached(blob).then(
      (fingerprint) => this.fingerprints.set(blob, fingerprint),
      () => undefined,
    );
  }

  keyFor(input: WorkerKeyInput): string | null {
    return previewFrameKey({
      ...input,
      buildId: BUILD_ID,
      mediaKey: (clip) => {
        const media = this.mediaFor(clip.id);
        if (!media) return null;
        const fingerprint = this.fingerprints.get(media.blob);
        // A proxy and its original draw differently: both are in the key.
        return fingerprint ? `${media.source}:${fingerprint}` : null;
      },
    });
  }
}
