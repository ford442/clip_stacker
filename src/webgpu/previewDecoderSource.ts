/**
 * Decoder-backed preview frame source (runs inside the preview worker).
 *
 * Replaces step 3–4 of the old preview loop — "post `need-frames`, main seeks a
 * hidden `<video>` and transfers a `VideoFrame`" — for every layer whose clip
 * media the demux facade can read (MP4, MOV, WebM / MKV, alpha included). The
 * worker holds the clip blobs itself (main only ever transfers the `File`,
 * once) and serves each layer from its own forward-only `DecoderFrameCursor`,
 * exactly like GPU export, except that preview cursors ask for a
 * latency-optimized decoder: a backward scrub reopens one, and the first frame
 * is what the user waits for. A reopen reads the cached container index and
 * the packets from the previous key frame on, never the whole file.
 *
 * The registered blob is whatever main resolved for preview: the clip's proxy
 * when one is ready and proxies are on, the original `File` otherwise (see
 * `resolvePreviewMedia`). A proxy layer never opens a full-res decoder.
 *
 * Anything it cannot serve (stills, audio-only, RIFE morph segments with their
 * own blob URL, a clip whose media was never registered, or media that fails to
 * open — an unknown container or a codec no decoder accepts) returns null and
 * stays on the `<video>` fallback for the rest of the session.
 */

import type { Clip } from '../types';
import type { PreviewMediaSource } from '../media/proxyMedia';
import { DecoderFrameCursor, type DecoderCursorOptions } from '../media/decoderCursor';
import {
  cursorStartAt,
  DecoderCursorPool,
  DEFAULT_MAX_DECODER_CURSORS,
  type ForwardFrameCursor,
} from '../media/decoderCursorPool';
import { ReverseChunkCache } from '../media/reverseFrames';
import { clipIsReversed } from '../timeline/reverseClip';
import { colorSpaceForOverride } from '../media/sourceColorSpace';
import type { CapturedFrame, FrameRequest, WorkerClip } from './previewWorkerProtocol';

/**
 * `startAt`: where in the window the cursor starts (a scrub target); omitted =
 * `trimStart`. `colorSpace`: the clip's source override, if any.
 */
export type CursorFactory = (
  blob: Blob,
  trimStart: number,
  trimEnd: number,
  startAt?: number,
  colorSpace?: VideoColorSpaceInit,
) => Promise<ForwardFrameCursor>;

/** Preview cursors only: export, proxies and stabilization decode for throughput. */
const PREVIEW_CURSOR_OPTIONS: DecoderCursorOptions = { optimizeForLatency: true };

const defaultCursorFactory: CursorFactory = (blob, trimStart, trimEnd, startAt, colorSpace) =>
  DecoderFrameCursor.open(blob, trimStart, trimEnd, {
    ...PREVIEW_CURSOR_OPTIONS,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(colorSpace ? { colorSpace } : {}),
  });

/** Stable per-layer cursor key. Crossfade roles and morph URLs get their own cursor. */
export function decoderLayerKey(request: FrameRequest): string {
  return `${request.clipId}::${request.role}::${request.mediaObjectUrl ?? ''}`;
}

export interface PreviewFrameSplit {
  /** Frames the decoder served, ready to composite. */
  decoded: CapturedFrame[];
  /** Requests that must still go to the main thread's `<video>` pool. */
  fallback: FrameRequest[];
  /** How many of `decoded` came from proxy bytes rather than the original. */
  proxyDecoded: number;
}

export class PreviewDecoderSource {
  private readonly media = new Map<string, { blob: Blob; source: PreviewMediaSource }>();
  private readonly pool: DecoderCursorPool;
  private readonly reverseCache: ReverseChunkCache;
  private pendingOpen: {
    blob: Blob;
    trimStart: number;
    trimEnd: number;
    colorSpace?: VideoColorSpaceInit;
  } | null = null;

  constructor(
    private readonly cursorFactory: CursorFactory = defaultCursorFactory,
    maxConcurrent: number = DEFAULT_MAX_DECODER_CURSORS,
  ) {
    this.pool = new DecoderCursorPool(async (_key, sourceTime) => {
      const open = this.pendingOpen;
      if (!open) throw new Error('no media staged for cursor open');
      const startAt = cursorStartAt(sourceTime, open.trimStart, open.trimEnd);
      if (open.colorSpace) {
        return this.cursorFactory(open.blob, open.trimStart, open.trimEnd, startAt, open.colorSpace);
      }
      return startAt === undefined
        ? this.cursorFactory(open.blob, open.trimStart, open.trimEnd)
        : this.cursorFactory(open.blob, open.trimStart, open.trimEnd, startAt);
    }, maxConcurrent);
    this.reverseCache = new ReverseChunkCache(async (_key, trimStart, trimEnd) => {
      const open = this.pendingOpen;
      if (!open) throw new Error('no media staged for reverse cursor');
      return open.colorSpace
        ? this.cursorFactory(open.blob, trimStart, trimEnd, undefined, open.colorSpace)
        : this.cursorFactory(open.blob, trimStart, trimEnd);
    });
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  /** Register (or replace) the preview blob for a clip — its proxy or its original. */
  setClipMedia(clipId: string, blob: Blob, source: PreviewMediaSource = 'original'): void {
    if (this.media.get(clipId)?.blob === blob) return;
    this.media.set(clipId, { blob, source });
    // A replaced blob invalidates any cursor already decoding the old bytes.
    this.pool.pruneKeys((key) => !key.startsWith(`${clipId}::`));
    this.reverseCache.pruneKeys((key) => !key.startsWith(`${clipId}::`));
  }

  hasClipMedia(clipId: string): boolean {
    return this.media.has(clipId);
  }

  /** Drop media + cursors for clips no longer on the timeline. */
  pruneExcept(clipIds: Set<string>): void {
    for (const id of [...this.media.keys()]) {
      if (!clipIds.has(id)) this.media.delete(id);
    }
    this.pool.pruneKeys((key) => clipIds.has(key.slice(0, key.indexOf('::'))));
    this.reverseCache.pruneKeys((key) => clipIds.has(key.slice(0, key.indexOf('::'))));
  }

  /** Free every live decoder without forgetting registered media (pause/idle). */
  releaseCursors(): void {
    this.pool.pruneKeys(() => false);
    this.reverseCache.destroy();
  }

  /**
   * Try to serve every request from a decoder; return the frames produced plus
   * the requests the main thread still has to capture.
   */
  async split(
    requests: FrameRequest[],
    clipsById: Map<string, WorkerClip | Clip>,
  ): Promise<PreviewFrameSplit> {
    const decoded: CapturedFrame[] = [];
    const fallback: FrameRequest[] = [];
    let proxyDecoded = 0;

    // Different layers own different cursors, but cursor opens hand a blob
    // through `pendingOpen`, so requests are served sequentially. Decode is
    // already the serialized resource here; parallelism would only queue on it.
    for (const request of requests) {
      const captured = await this.tryServe(request, clipsById);
      if (captured) {
        decoded.push(captured);
        if (this.media.get(request.clipId)?.source === 'proxy') proxyDecoded += 1;
      } else {
        fallback.push(request);
      }
    }

    return { decoded, fallback, proxyDecoded };
  }

  private async tryServe(
    request: FrameRequest,
    clipsById: Map<string, WorkerClip | Clip>,
  ): Promise<CapturedFrame | null> {
    // RIFE morph segments live in a blob URL main owns; they stay on <video>.
    if (request.mediaObjectUrl) return null;

    const clip = clipsById.get(request.clipId);
    if (!clip || clip.kind !== 'video' || clip.stillImage) return null;

    const blob = this.media.get(request.clipId)?.blob;
    if (!blob) return null;

    // An override decodes differently: changing it opens a new cursor.
    const override = clip.colorSpaceOverride;
    const key = override ? `${decoderLayerKey(request)}::${override}` : decoderLayerKey(request);
    if (this.pool.isUnsupported(key)) return null;

    const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    this.pendingOpen = {
      blob,
      trimStart: clip.trimStart,
      trimEnd,
      ...(override ? { colorSpace: colorSpaceForOverride(override) } : {}),
    };
    let frame: VideoFrame | null;
    try {
      // Reversed playback seeks backward every frame. The chunk cache decodes
      // ~1s at a time instead of reopening the decoder per frame.
      frame = clipIsReversed(clip)
        ? ((await this.reverseCache.frameAt(key, request.sourceTime, clip.trimStart, trimEnd)) as VideoFrame | null)
        : await this.pool.frameAt(key, request.sourceTime);
    } catch {
      return null;
    } finally {
      this.pendingOpen = null;
    }
    if (!frame) return null;

    return {
      clipId: request.clipId,
      role: request.role,
      frame,
      videoWidth: frame.displayWidth || frame.codedWidth,
      videoHeight: frame.displayHeight || frame.codedHeight,
    };
  }

  destroy(): void {
    this.pool.destroy();
    this.reverseCache.destroy();
    this.media.clear();
  }
}
