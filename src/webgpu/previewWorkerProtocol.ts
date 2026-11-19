/**
 * Typed protocol for the off-thread WebGPU preview worker, served through
 * the worker RPC (`src/workers/workerRpc.ts`).
 *
 * Startup (two-phase so the display canvas is never transferred unless the
 * worker can actually run WebGPU):
 *   1. Main calls `configure`; the worker answers with its GPU probe (no
 *      canvas yet).
 *   2. Main transfers OffscreenCanvas (`init`) only when `webgpuAvailable`.
 *   3. `init` resolves once the real compositor is up.
 * A failed probe is a hard-fail for GPU preview — not a Canvas2D stand-in.
 *
 * Frame sourcing: the worker decodes what it can itself (`clip-media` gives it
 * the clip blobs once) and only asks main for the layers its decoder cannot
 * serve (`need-frames` → `frames-ready`, the stream channel), so the happy
 * path never touches `HTMLVideoElement.currentTime`.
 *
 * The worker owns its own `GPUDevice` (see `gpuDevice.ts`), so the `gpu-*`
 * events are the only way main learns the preview's device died or
 * misbehaved.
 */

import type {
  CaptionEntry,
  Clip,
  ClipGroup,
  ClipTransition,
  ExportSettings,
  TextOverlay,
  TextOverlayStyle,
} from '../types';
import type { FinishingSettings } from '../finishing/finishing';
import type { ColorDebugSnapshot, ColorManagementSettings } from '../finishing/colorManagement';
import type { ColorGradeSettings } from '../finishing/lut';
import type { PreviewCompositionPlan } from '../composition/previewComposition';
import type { GpuChoreJobSpec, GpuChoreResult } from '../gpu-chores/types';
import type { WebGpuProbeResult } from './webgpuProbe';
import type { GpuErrorLogEntry } from './gpuDevice';
import type { PreviewMediaSource } from '../media/proxyMedia';

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
  /** True when main captured this from the clip's preview proxy, not the original. */
  proxy?: boolean;
}

/** Which scopes the worker should compute from the composed preview texture. */
export interface ScopeSettings {
  waveform: boolean;
  vectorscope: boolean;
}

export const SCOPES_OFF: ScopeSettings = { waveform: false, vectorscope: false };

/** One frame's scope readback (bins are plain typed arrays, transferred). */
export interface ScopeData {
  /** 256 Rec.709 luma bins. */
  histogram?: Uint32Array;
  /** `vectorscopeSize²` CbCr bins, row-major (V rows, U columns). */
  vectorscope?: Uint32Array;
  vectorscopeSize?: number;
  /** Composed frame size the scopes were measured on. */
  width: number;
  height: number;
}

/** How each layer of a rendered frame was sourced (decoder vs `<video>` seek). */
export interface FrameSourceStats {
  decoder: number;
  element: number;
  /**
   * Layers (of `decoder` + `element`) served from a preview proxy rather than
   * the original file. Omitted by older senders — treat as 0.
   */
  proxy?: number;
}

/** How long main waits for the worker GPU probe / init before falling back. */
export const PREVIEW_WORKER_INIT_TIMEOUT_MS = 5_000;

/** A `render` call: one preview frame at `globalTime`. */
export interface PreviewRenderRequest {
  /** Names the frame in `need-frames` / `frames-ready`. */
  renderId: number;
  clips: WorkerClip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  exportSettings: Pick<ExportSettings, 'outputResolution'> | undefined;
  globalTime: number;
  maxWidth?: number | undefined;
  maxHeight?: number | undefined;
  finishing?: FinishingSettings | undefined;
  /** Output color / working space for the managed pipeline. */
  colorManagement?: ColorManagementSettings | undefined;
  /** @deprecated Prefer `finishing`. */
  colorGrade?: ColorGradeSettings | undefined;
  /** Caption cues to plan for; omitted or empty means no caption layers. */
  captions?: CaptionEntry[] | undefined;
  captionStyle?: Partial<TextOverlayStyle> | undefined;
}

/** A completed `render` (null = cancelled, or no compositor yet). */
export interface PreviewRenderResult {
  plan: PreviewCompositionPlan;
  /** Per-layer frame sourcing for this frame (decoder path vs `<video>`). */
  frameSources: FrameSourceStats;
  /** `?gpu_profile`: the worker's averaged GPU milliseconds per pass. */
  gpuProfile?: Record<string, number>;
}

export type PreviewWorkerProtocol = {
  // ---- calls ------------------------------------------------------------
  /**
   * First call, made right after the worker is constructed: page flags
   * resolved on main that must be set before the worker requests its
   * device. Answers with the GPU probe (no canvas has moved yet).
   */
  configure: {
    req: {
      /** `?gpu_profile`: request `timestamp-query` and post pass timings. */
      gpuProfile: boolean;
      /** `?test_harness`: live preview may run on a software fallback adapter. */
      allowFallbackAdapter: boolean;
    };
    res: { webgpuAvailable: boolean; webgpuProbe: WebGpuProbeResult };
  };
  /** Bind the compositor to the transferred canvas; rejects when it cannot start. */
  init: {
    req: {
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      /**
       * Resolved on main (a worker's `location.search` is the worker script's,
       * not the page's). False keeps every layer on the `<video>` fallback.
       */
      decoderEnabled?: boolean | undefined;
    };
    res: void;
  };
  /** Abort the call to cancel the frame (the worker checks between stages). */
  render: { req: PreviewRenderRequest; res: PreviewRenderResult | null };
  /** gpu-chores kernels on the worker's adopted device (`source` transferred). */
  'chore-jobs': { req: { jobs: GpuChoreJobSpec[]; source?: ImageBitmap | undefined }; res: GpuChoreResult[] };

  // ---- stream channel: main → worker ------------------------------------
  /**
   * The source bytes for clips the worker should decode itself. `Blob`/`File`
   * is structured-cloneable by reference — no copy. `source` says whether
   * `blob` is the clip's proxy or its original (default).
   */
  'clip-media': { notify: { media: Array<{ clipId: string; blob: Blob; source?: PreviewMediaSource }> } };
  /** Main's answer to `need-frames` (the frames are transferred). */
  'frames-ready': { notify: { renderId: number; frames: CapturedFrame[] } };
  resize: { notify: { width: number; height: number } };
  'sync-clips': { notify: { clips: WorkerClip[] } };
  'pause-decoders': { notify: void };
  'reset-finishing': { notify: void };
  'set-scopes': { notify: { scopes: ScopeSettings } };
  /** Main's `(dynamic-range: high)`: an HDR10 project previews extended on an HDR display. */
  'display-hdr': { notify: { hdr: boolean } };
  destroy: { notify: void };

  // ---- stream channel: worker → main ------------------------------------
  /** Layers the worker's decoder cannot serve; main answers with `frames-ready`. */
  'need-frames': { event: { renderId: number; requests: FrameRequest[] } };
  scopes: { event: { renderId: number; scopes: ScopeData } };
  'color-state': { event: { snapshot: ColorDebugSnapshot } };
  /** An uncaptured error on the worker's device (validation / OOM / internal). */
  'gpu-error': { event: { entry: GpuErrorLogEntry } };
  /** The worker's device was lost; it is recreating one. */
  'gpu-lost': { event: { message: string; timestamp: number } };
  /** The worker's compositor is running on a freshly recreated device. */
  'gpu-recovered': { event: void };
  /** Recreating the worker's device failed — the preview cannot draw. */
  'gpu-recovery-failed': { event: { message: string; timestamp: number } };
};
