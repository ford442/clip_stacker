/**
 * Canvas encoder — orchestrates the full hybrid rendering pipeline:
 *
 *   1. CanvasRenderer  — plays clips onto a 2D canvas in real-time, applying
 *                        audio-reactive effects via Web Audio AnalyserNode.
 *   2. MediaRecorder   — captures the canvas stream as a video-only blob.
 *   3. FFmpeg.wasm     — muxes the captured video with high-quality audio
 *                        extracted from the original clip files.
 *
 * This path unlocks audio-reactive fades, WebGL shaders, and advanced
 * compositing that are not possible with the pure FFmpeg filter-graph path.
 *
 * Usage:
 *   const blob = await encodeClipsWithCanvas(clips, settings, setStatus, true);
 */

import type { Clip, ExportSettings } from '../types';
import type { StatusCallback, ProgressCallback } from '../ffmpeg/ffmpegService';
import { muxVideoWithAudio } from '../ffmpeg/ffmpegService';
import { getClipDuration } from './project';
import { CanvasRenderer } from './canvas-renderer';
import { startCanvasCapture } from './media-recorder-encoder';

const CANVAS_RENDER_START = 0.02;
const CANVAS_RENDER_RANGE = 0.83;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode clips using the hybrid Canvas → MediaRecorder → FFmpeg mux pipeline.
 *
 * @param clips         - Ordered list of clips to render.
 * @param settings      - Export quality settings (bitrate, etc.).
 * @param onStatus      - Status callback for progress messages.
 * @param audioReactive - Enable audio-reactive visual effects (default true).
 */
export async function encodeClipsWithCanvas(
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  audioReactive = true,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (clips.length === 0) throw new Error('No clips to render.');

  onStatus('Initializing canvas renderer...');
  onProgress?.({ stage: 'Initializing canvas renderer', progress: 0, indeterminate: false });

  // Create an off-screen canvas (not attached to DOM; capture still works).
  const canvas = document.createElement('canvas');
  const renderer = new CanvasRenderer(canvas, { audioReactive });

  // Start capturing the canvas stream before rendering begins so no frames
  // are dropped at the start.
  const captureHandle = startCanvasCapture(canvas, {
    videoBitsPerSecond: settings.videoBitrate,
  });

  const totalDuration = clips.reduce((sum, c) => sum + getClipDuration(c), 0);

  onStatus('Canvas render started (real-time playback)...');
  onProgress?.({ stage: 'Canvas render (real-time playback)', progress: CANVAS_RENDER_START, indeterminate: false });

  try {
    await renderer.renderClips(clips, (progress) => {
      const pct = totalDuration > 0
        ? Math.round((progress.totalElapsed / totalDuration) * 100)
        : 0;
      const normalized = totalDuration > 0
        ? Math.max(0, Math.min(1, progress.totalElapsed / totalDuration))
        : 0;
      onProgress?.({
        stage: `Canvas render: ${progress.clipTitle}`,
        progress: CANVAS_RENDER_START + normalized * CANVAS_RENDER_RANGE,
        indeterminate: totalDuration <= 0,
      });
      onStatus(
        `Canvas render [${progress.clipIndex + 1}/${progress.totalClips}]: ` +
        `"${progress.clipTitle}" (${pct}%)${audioReactive ? ' 🎵' : ''}`,
      );
    });
  } catch (err) {
    // If the renderer fails mid-way, stop the recorder and re-throw.
    try { await captureHandle.stop(); } catch { /* ignore */ }
    throw err;
  }

  onStatus('Finalizing canvas capture...');
  onProgress?.({ stage: 'Finalizing canvas capture', progress: 0.87, indeterminate: false });
  const videoBlob = await captureHandle.stop();

  onStatus('Muxing with high-quality audio...');
  onProgress?.({ stage: 'Muxing with high-quality audio', progress: 0.88, indeterminate: false });
  return muxVideoWithAudio(videoBlob, clips, settings, onStatus, onProgress);
}
