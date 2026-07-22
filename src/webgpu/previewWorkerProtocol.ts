/**
 * Typed message protocol for the off-thread WebGPU preview worker.
 *
 * Main → Worker: init, render, frames-ready, cancel, resize, sync-clips,
 *                pause-decoders, destroy
 * Worker → Main: ready, need-frames, render-complete, render-cancelled, error
 */

import type {
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
} from '../types';
import type { ColorGradeSettings } from '../utils/lut';
import type { PreviewCompositionPlan } from '../utils/previewComposition';

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
  | { type: 'destroy' };

// --------------------------------------------------------------------------
// Worker → Main messages
// --------------------------------------------------------------------------

export type PreviewWorkerOutbound =
  | {
      type: 'ready';
      webgpuAvailable: boolean;
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
      type: 'error';
      message: string;
    };
