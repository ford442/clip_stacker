/**
 * Hybrid encoder — automatically selects the best available encoding path:
 *
 *   1. Canvas renderer (audio-reactive) — browser compositing + MediaRecorder +
 *      FFmpeg audio mux; unlocks audio-reactive effects and advanced compositing.
 *   2. WebCodecs (GPU H.264 + AAC)       — fastest, requires Chrome 94+ with
 *      hardware H.264 support.
 *   3. FFmpeg.wasm                        — CPU, works everywhere (default).
 *
 * The caller only needs to call `hybridMergeClips` and handle the returned Blob.
 */

import type { Clip, ExportSettings, ClipTransition, TextOverlay, RenderPlan } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { isWebCodecsAvailable, encodeClipsWithWebCodecs } from './webcodecs';
import { mergeClips, calculateRenderPlan } from '../ffmpeg/ffmpegService';
import { encodeClipsWithCanvas } from './canvas-encoder';

export type EncoderPath = 'webcodecs' | 'ffmpeg' | 'canvas';

export interface HybridEncodeResult {
  blob: Blob;
  path: EncoderPath;
  renderPlan?: RenderPlan;
}

/**
 * Merge clips using the best available encoder.
 *
 * @param clips          - Ordered list of clips to merge
 * @param transitions    - Optional transitions between clips
 * @param settings       - Export quality settings
 * @param onStatus       - Status callback for progress updates
 * @param forceFFmpeg    - Set to true to bypass WebCodecs detection
 * @param textOverlays   - Optional text overlays / tickers to burn into the output
 * @param useCanvas      - Set to true to use the canvas renderer path (enables
 *                         audio-reactive effects); requires MediaRecorder support
 * @param audioReactive  - Enable audio-reactive visual effects in the canvas path
 * @param forceReencode  - Set to true to force re-encoding even for lossless concat cases
 * @param renderPlan     - Pre-calculated render plan to avoid redundant computation
 */
export async function hybridMergeClips(
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
  forceFFmpeg = false,
  textOverlays: TextOverlay[] = [],
  useCanvas = false,
  audioReactive = true,
  forceReencode = false,
  renderPlan?: RenderPlan,
): Promise<HybridEncodeResult> {
  let canvasFailure: string | null = null;
  let webcodecsFailure: string | null = null;

  // -- Canvas renderer path --------------------------------------------------
  if (useCanvas && typeof MediaRecorder !== 'undefined') {
    try {
      onStatus('Canvas renderer path selected (audio-reactive compositing)...');
      onProgress?.({ stage: 'Canvas renderer selected', progress: 0, indeterminate: false });
      const blob = await encodeClipsWithCanvas(clips, settings, onStatus, audioReactive, onProgress);
      return { blob, path: 'canvas' };
    } catch (err) {
      canvasFailure = (err as Error).message;
      onStatus(`Canvas render failed (${canvasFailure}). Falling back to FFmpeg...`);
    }
  }

  // -- WebCodecs GPU path ----------------------------------------------------
  const useWebCodecs = !forceFFmpeg && !useCanvas && (await isWebCodecsAvailable());

  if (useWebCodecs) {
    // WebCodecs path doesn't support transitions, PiP overlays, or text overlays.
    const hasActiveTransitions = transitions.some((t) => t.type !== 'none' && t.duration > 0);
    const hasPipClips = clips.some((c) => (c.layerIndex ?? 0) > 0);
    const hasTextOverlays = textOverlays.length > 0;
    if (!hasActiveTransitions && !hasPipClips && !hasTextOverlays) {
      try {
        onStatus('GPU path selected (WebCodecs + hardware H.264)...');
        onProgress?.({ stage: 'GPU path selected (WebCodecs)', progress: 0, indeterminate: false });
        const blob = await encodeClipsWithWebCodecs(clips, settings, onStatus, onProgress);
        return { blob, path: 'webcodecs' };
      } catch (err) {
        webcodecsFailure = (err as Error).message;
        onStatus(`GPU encode failed (${webcodecsFailure}). Falling back to FFmpeg...`);
      }
    }
  }

  // -- FFmpeg path (default / fallback) -------------------------------------
  onProgress?.({ stage: 'FFmpeg path selected', progress: 0, indeterminate: false });
  try {
    const blob = await mergeClips(clips, transitions, settings, onStatus, textOverlays, onProgress, forceReencode);
    const effectiveRenderPlan = renderPlan || calculateRenderPlan(clips, transitions, textOverlays, settings);
    return { blob, path: 'ffmpeg', renderPlan: effectiveRenderPlan };
  } catch (err) {
    // Chain prior fallback messages so the final error is maximally diagnostic.
    if (canvasFailure || webcodecsFailure) {
      const prev: string[] = [];
      if (canvasFailure) prev.push(`Canvas: ${canvasFailure}`);
      if (webcodecsFailure) prev.push(`WebCodecs: ${webcodecsFailure}`);
      const orig = (err as Error).message;
      const e = new Error(`${orig}\n\nPrevious encoder attempts that also failed:\n${prev.join('\n')}`);
      (e as any).ffmpegLogs = (err as any).ffmpegLogs;
      throw e;
    }
    throw err;
  }
}
