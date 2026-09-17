/**
 * Decoder-backed preview frame source (runs inside the preview worker).
 *
 * Replaces step 3–4 of the old preview loop — "post `need-frames`, main seeks a
 * hidden `<video>` and transfers a `VideoFrame`" — for every layer whose clip
 * media mp4box can demux. The worker holds the clip blobs itself (main only
 * ever transfers the `File`, once) and serves each layer from its own
 * forward-only `DecoderFrameCursor`, exactly like GPU export.
 *
 * Anything it cannot serve (WebM/alpha, stills, audio-only, RIFE morph segments
 * with their own blob URL, or a clip whose media was never registered) returns
 * null and stays on the `<video>` fallback for the rest of the session.
 */

import type { Clip } from '../types';
import { DecoderFrameCursor } from '../utils/decoderCursor';
import {
  DecoderCursorPool,
  DEFAULT_MAX_DECODER_CURSORS,
  type ForwardFrameCursor,
} from '../utils/decoderCursorPool';
import type { CapturedFrame, FrameRequest, WorkerClip } from './previewWorkerProtocol';

/** Ring-buffer depth per *active* layer (not per library clip). */
export const PREVIEW_RING_BUFFER_CAPACITY = 12;

export type CursorFactory = (
  blob: Blob,
  trimStart: number,
  trimEnd: number,
) => Promise<ForwardFrameCursor>;

const defaultCursorFactory: CursorFactory = (blob, trimStart, trimEnd) =>
  DecoderFrameCursor.open(blob, trimStart, trimEnd);

/** Stable per-layer cursor key. Crossfade roles and morph URLs get their own cursor. */
export function decoderLayerKey(request: FrameRequest): string {
  return `${request.clipId}::${request.role}::${request.mediaObjectUrl ?? ''}`;
}

export interface PreviewFrameSplit {
  /** Frames the decoder served, ready to composite. */
  decoded: CapturedFrame[];
  /** Requests that must still go to the main thread's `<video>` pool. */
  fallback: FrameRequest[];
}

export class PreviewDecoderSource {
  private readonly media = new Map<string, Blob>();
  private readonly pool: DecoderCursorPool;
  private pendingOpen: { blob: Blob; trimStart: number; trimEnd: number } | null = null;

  constructor(
    private readonly cursorFactory: CursorFactory = defaultCursorFactory,
    maxConcurrent: number = DEFAULT_MAX_DECODER_CURSORS,
  ) {
    this.pool = new DecoderCursorPool(async () => {
      const open = this.pendingOpen;
      if (!open) throw new Error('no media staged for cursor open');
      return this.cursorFactory(open.blob, open.trimStart, open.trimEnd);
    }, maxConcurrent);
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  /** Register (or replace) the source blob for a clip. */
  setClipMedia(clipId: string, blob: Blob): void {
    if (this.media.get(clipId) === blob) return;
    this.media.set(clipId, blob);
    // A replaced blob invalidates any cursor already decoding the old bytes.
    this.pool.pruneKeys((key) => !key.startsWith(`${clipId}::`));
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
  }

  /** Free every live decoder without forgetting registered media (pause/idle). */
  releaseCursors(): void {
    this.pool.pruneKeys(() => false);
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

    // Different layers own different cursors, but cursor opens hand a blob
    // through `pendingOpen`, so requests are served sequentially. Decode is
    // already the serialized resource here; parallelism would only queue on it.
    for (const request of requests) {
      const captured = await this.tryServe(request, clipsById);
      if (captured) decoded.push(captured);
      else fallback.push(request);
    }

    return { decoded, fallback };
  }

  private async tryServe(
    request: FrameRequest,
    clipsById: Map<string, WorkerClip | Clip>,
  ): Promise<CapturedFrame | null> {
    // RIFE morph segments live in a blob URL main owns; they stay on <video>.
    if (request.mediaObjectUrl) return null;

    const clip = clipsById.get(request.clipId);
    if (!clip || clip.kind !== 'video' || clip.stillImage) return null;

    const blob = this.media.get(request.clipId);
    if (!blob) return null;

    const key = decoderLayerKey(request);
    if (this.pool.isUnsupported(key)) return null;

    const trimEnd = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    this.pendingOpen = { blob, trimStart: clip.trimStart, trimEnd };
    let frame: VideoFrame | null = null;
    try {
      frame = await this.pool.frameAt(key, request.sourceTime);
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
    this.media.clear();
  }
}
