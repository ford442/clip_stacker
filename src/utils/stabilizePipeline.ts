/**
 * Clip -> stabilization matrices.
 *
 * Decodes the source sequentially (never seeks — see `webcodecs-decoder.ts`),
 * downscales each sampled frame to an analysis-sized grayscale buffer, and
 * feeds those to the `video_stabilize` WASM module.
 *
 * Analysis always covers the WHOLE source, not the trim window, so matrix
 * index maps directly to source time. Dragging a trim handle is a frequent
 * edit and re-running optical flow is not — this way trimming costs nothing.
 */

import type { Clip, ClipStabilization } from '../types';
import { ClipFrameDecoder } from './webcodecs-decoder';
import {
  createStabilizer,
  STAB_MATRIX_FLOATS,
  type Stabilizer,
} from '../wasm/videoStabilize';
import {
  DEFAULT_STABILIZE_ANALYSIS_EDGE,
  DEFAULT_STABILIZE_ANALYSIS_FPS,
  MAX_STABILIZE_FRAMES,
} from './stabilization';

/** Moving-average window, in seconds of source time. */
export const DEFAULT_STABILIZE_SMOOTH_SECONDS = 1;

export interface StabilizeOptions {
  /** Frames per second to sample the source at. */
  analysisFps?: number;
  /** Long edge of the analysis frame, in pixels. */
  analysisEdge?: number;
  /** Moving-average half-width, in seconds. */
  smoothSeconds?: number;
  /** Hard cap on analysed frames (protects very long clips). */
  maxFrames?: number;
  /** Directory URL holding the WASM assets (tests). */
  baseUrl?: string;
  /** Cooperative cancellation, checked between frames. */
  isCancelled?: () => boolean;
  onProgress?: (analysed: number, estimatedTotal: number) => void;
}

export type StabilizeResult =
  | { ok: true; stabilization: ClipStabilization }
  | { ok: false; reason: string };

export interface AnalysisPlan {
  width: number;
  height: number;
  fps: number;
  smoothRadius: number;
  /** Frames the plan expects to analyse (for progress reporting). */
  estimatedFrames: number;
}

/**
 * Pick the analysis resolution and sampling rate for a source.
 *
 * Long clips drop their sampling rate rather than truncating, so the whole
 * clip stays covered; the smoothing radius is derived from the final fps so
 * the smoothing window stays the same number of *seconds* either way.
 */
export function computeAnalysisPlan(
  videoWidth: number,
  videoHeight: number,
  durationSec: number,
  options: StabilizeOptions = {},
): AnalysisPlan {
  const edge = Math.max(64, options.analysisEdge ?? DEFAULT_STABILIZE_ANALYSIS_EDGE);
  const maxFrames = Math.max(2, options.maxFrames ?? MAX_STABILIZE_FRAMES);
  const requestedFps = Math.max(1, options.analysisFps ?? DEFAULT_STABILIZE_ANALYSIS_FPS);
  const smoothSeconds = Math.max(
    0.05,
    options.smoothSeconds ?? DEFAULT_STABILIZE_SMOOTH_SECONDS,
  );

  const srcW = Math.max(1, Math.round(videoWidth));
  const srcH = Math.max(1, Math.round(videoHeight));
  const scale = Math.min(1, edge / Math.max(srcW, srcH));
  const width = Math.max(16, Math.round(srcW * scale));
  const height = Math.max(16, Math.round(srcH * scale));

  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const fps =
    duration > 0 && duration * requestedFps > maxFrames
      ? Math.max(1, maxFrames / duration)
      : requestedFps;

  return {
    width,
    height,
    fps,
    smoothRadius: Math.max(1, Math.round(smoothSeconds * fps)),
    estimatedFrames: duration > 0 ? Math.max(1, Math.round(duration * fps)) : 0,
  };
}

/** Rec.709 luma from an RGBA buffer, written into `out` (one byte per pixel). */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, out: Uint8Array): Uint8Array {
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Round, don't truncate: truncating turns pure white into 254 and biases
    // the whole analysis frame a level dark.
    out[i] =
      (rgba[o]! * 0.2126 + rgba[o + 1]! * 0.7152 + rgba[o + 2]! * 0.0722 + 0.5) | 0;
  }
  return out;
}

/**
 * Core analysis: grayscale frames in, correction matrices out.
 *
 * Split from the decoding above it so the whole smoothing/correction path can
 * be tested against synthetic footage without a VideoDecoder or a canvas.
 */
export async function analyzeGrayFrames(
  frames: AsyncIterable<Uint8Array>,
  plan: AnalysisPlan,
  options: StabilizeOptions = {},
): Promise<StabilizeResult> {
  const stabilizer: Stabilizer = await createStabilizer(
    plan.width,
    plan.height,
    plan.smoothRadius,
    { baseUrl: options.baseUrl },
  );
  if (!stabilizer.available) {
    return { ok: false, reason: stabilizer.reason };
  }

  try {
    let count = 0;
    for await (const gray of frames) {
      if (options.isCancelled?.()) {
        return { ok: false, reason: 'cancelled' };
      }
      stabilizer.pushFrame(gray);
      count += 1;
      options.onProgress?.(count, plan.estimatedFrames);
    }

    if (count < 2) {
      return { ok: false, reason: `not enough frames to analyse (${count})` };
    }

    stabilizer.finalize();
    const matrices = stabilizer.getAllMatrices();
    return {
      ok: true,
      stabilization: {
        fps: plan.fps,
        matrices,
        frameCount: matrices.length / STAB_MATRIX_FLOATS,
        zoom: stabilizer.zoom,
        maxCorrection: stabilizer.maxCorrection,
        smoothRadius: plan.smoothRadius,
      },
    };
  } finally {
    stabilizer.destroy();
  }
}

interface AnalysisCanvas {
  drawFrame(frame: VideoFrame): Uint8ClampedArray | null;
}

/** OffscreenCanvas where available, a DOM canvas otherwise, null in neither. */
function createAnalysisCanvas(width: number, height: number): AnalysisCanvas | null {
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) return null;

  return {
    drawFrame(frame: VideoFrame): Uint8ClampedArray | null {
      try {
        ctx!.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
        return ctx!.getImageData(0, 0, width, height).data;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Decode `clip`, sampling at the plan's fps, and yield analysis-sized gray frames.
 * Every decoded VideoFrame is closed before the next is pulled.
 */
async function* decodeGrayFrames(
  clip: Clip,
  plan: AnalysisPlan,
  options: StabilizeOptions,
): AsyncGenerator<Uint8Array> {
  const canvas = createAnalysisCanvas(plan.width, plan.height);
  if (!canvas) throw new Error('no 2D canvas available for stabilization analysis');

  const decoder = await ClipFrameDecoder.open(clip.file, {
    trimStart: 0,
    trimEnd: Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : Infinity,
  });
  // One reused buffer: pushFrame copies into the WASM heap synchronously, so
  // the next iteration can safely overwrite it.
  const gray = new Uint8Array(plan.width * plan.height);
  const interval = 1 / plan.fps;
  let nextSampleTime = 0;

  try {
    for await (const frame of decoder.frames()) {
      try {
        if (options.isCancelled?.()) return;
        const t = frame.timestamp / 1_000_000;
        // Sample on a fixed grid so matrix index == round(sourceTime * fps).
        if (t + 1e-6 < nextSampleTime) continue;
        const rgba = canvas.drawFrame(frame);
        if (!rgba) continue;
        nextSampleTime += interval;
        yield rgbaToGray(rgba, gray);
      } finally {
        frame.close();
      }
    }
  } finally {
    decoder.close();
  }
}

/**
 * Analyse one clip end to end. Never throws: every failure path (no WASM, no
 * WebCodecs, an undecodable file) comes back as `{ ok: false, reason }` so the
 * caller can leave the clip unstabilized.
 */
export async function stabilizeClip(
  clip: Clip,
  options: StabilizeOptions = {},
): Promise<StabilizeResult> {
  if (clip.kind !== 'video') return { ok: false, reason: 'not a video clip' };
  if (clip.stillImage) return { ok: false, reason: 'still images have no camera shake' };

  const plan = computeAnalysisPlan(
    clip.videoWidth ?? 0,
    clip.videoHeight ?? 0,
    clip.duration,
    options,
  );

  try {
    return await analyzeGrayFrames(decodeGrayFrames(clip, plan, options), plan, options);
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message || String(err) };
  }
}
