/**
 * Typed message protocol for the off-thread WebGPU preview worker.
 *
 * Startup (two-phase so the display canvas is never transferred unless the
 * worker can actually run WebGPU):
 *   1. Worker boots and posts `ready` after a GPU probe (no canvas yet).
 *   2. Main transfers OffscreenCanvas only when `webgpuAvailable: true`.
 *   3. Worker posts `initialized` once the real compositor is up.
 * A failed probe is a hard-fail for GPU preview — not a Canvas2D stand-in.
 *
 * Main → Worker: init, render, frames-ready, cancel, resize, sync-clips,
 *                pause-decoders, reset-finishing, chore-jobs, destroy
 * Worker → Main: ready, initialized, need-frames, render-complete,
 *                render-cancelled, chore-jobs-result, error
 */

import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
} from '../types';
import type { FinishingSettings } from '../utils/finishing';
import type { ColorGradeSettings } from '../utils/lut';
import type { PreviewCompositionPlan } from '../utils/previewComposition';
import type { GpuChoreJobSpec, GpuChoreResult } from '../gpu-chores/types';
import type { WebGpuProbeResult } from './webgpuProbe';

/**
 * Clip descriptor sent to the worker — identical to Clip but without the
 * `file: File` field, which is not serializable via postMessage.
 * objectUrl (a blob: string) is kept so the worker can include it in
 * need-frames requests for RIFE morph segments.
 */
export type WorkerClip = Omit<Clip, 'file'>;

export function toWorkerClip(clip: Clip): WorkerClip {
  const { file: _file, ...rest } = clip;
  return rest;
}

/**
 * Stable key for grouping frame-capture work. Requests that share a media
 * element must stay sequential; different keys can run in parallel.
 */
export function frameCaptureGroupKey(request: {
  clipId: string;
  mediaObjectUrl?: string;
}): string {
  return request.mediaObjectUrl
    ? `${request.clipId}::${request.mediaObjectUrl}`
    : request.clipId;
}

/**
 * Partition frame requests into parallel-safe groups (one group per media
 * element). Order within each group is preserved; group order follows first
 * appearance in `requests`.
 */
export function groupFrameRequestsByMedia<T extends {
  clipId: string;
  mediaObjectUrl?: string;
}>(requests: T[]): T[][] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const request of requests) {
    const key = frameCaptureGroupKey(request);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(request);
  }
  return order.map((key) => groups.get(key)!);
}

/**
 * Per-frame request sent from the worker to the main thread: the worker has
 * computed the composition plan and needs the main thread to capture
 * VideoFrames from the pooled hidden <video> elements.
 */
export interface FrameRequest {
  /** Clip ID used to look up the media element in ClipMediaPool. */
  clipId: string;
  /**
   * Role within the current frame: 'base' or 'pip' for single-layer, or
   * 'outgoing'/'incoming' for GPU transition pairs.
   */
  role: string;
  /** Media time in seconds to seek to before capturing. */
  sourceTime: number;
  /**
   * Optional override object URL (used for RIFE morph segments which have
   * their own blob URL distinct from the clip's main objectUrl).
   */
  mediaObjectUrl?: string;
  /** Frame dimensions from the video element (needed for letterbox UV). */
  videoWidth?: number;
  videoHeight?: number;
}

/** Frame captured by the main thread and transferred to the worker. */
export interface CapturedFrame {
  clipId: string;
  role: string;
  frame: VideoFrame;
  /** Video element dimensions at the time of capture (for letterbox UV). */
  videoWidth: number;
  videoHeight: number;
}

/** How long main waits for the worker GPU probe / init before falling back. */
export const PREVIEW_WORKER_INIT_TIMEOUT_MS = 5_000;

// --------------------------------------------------------------------------
// Main → Worker messages
// --------------------------------------------------------------------------

export type PreviewWorkerInbound =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
    }
  | {
      type: 'render';
      renderId: number;
      clips: WorkerClip[];
      clipGroups: ClipGroup[];
      transitions: ClipTransition[];
      textOverlays: TextOverlay[];
      exportSettings: Pick<ExportSettings, 'outputResolution'> | undefined;
      globalTime: number;
      maxWidth?: number;
      maxHeight?: number;
      finishing?: FinishingSettings;
      /** @deprecated Prefer `finishing`. */
      colorGrade?: ColorGradeSettings;
    }
  | {
      type: 'frames-ready';
      renderId: number;
      frames: CapturedFrame[];
    }
  | {
      type: 'cancel';
      renderId: number;
    }
  | {
      type: 'resize';
      width: number;
      height: number;
    }
  | {
      type: 'sync-clips';
      clips: WorkerClip[];
    }
  | { type: 'pause-decoders' }
  | { type: 'reset-finishing' }
  | {
      type: 'chore-jobs';
      id: number;
      jobs: GpuChoreJobSpec[];
      source?: ImageBitmap;
    }
  | { type: 'destroy' };

// --------------------------------------------------------------------------
// Worker → Main messages
// --------------------------------------------------------------------------

export type PreviewWorkerOutbound =
  | {
      /** GPU probe result — posted before any canvas is transferred. */
      type: 'ready';
      webgpuAvailable: boolean;
      webgpuProbe: WebGpuProbeResult;
    }
  | {
      /** Real compositor is bound to the transferred OffscreenCanvas. */
      type: 'initialized';
    }
  | {
      type: 'need-frames';
      renderId: number;
      requests: FrameRequest[];
    }
  | {
      type: 'render-complete';
      renderId: number;
      plan: PreviewCompositionPlan;
    }
  | {
      type: 'render-cancelled';
      renderId: number;
    }
  | {
      type: 'chore-jobs-result';
      id: number;
      ok: true;
      results: GpuChoreResult[];
    }
  | {
      type: 'chore-jobs-result';
      id: number;
      ok: false;
      message: string;
    }
  | {
      type: 'error';
      message: string;
    };
