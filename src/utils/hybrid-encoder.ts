/**
 * Hybrid encoder — automatically selects the best available encoding path:
 *
 *   1. WebCodecs (GPU H.264 + AAC)  — fastest, requires Chrome 94+ with hardware H.264 support
 *   2. FFmpeg.wasm two-pass            — CPU, works everywhere
 *
 * The caller only needs to call `hybridMergeClips` and handle the returned Blob.
 */

import type { Clip, ExportSettings, ClipTransition } from '../types';
import type { StatusCallback } from '../ffmpeg/ffmpegService';
import { isWebCodecsAvailable, encodeClipsWithWebCodecs } from './webcodecs';
import { mergeClips } from '../ffmpeg/ffmpegService';

export type EncoderPath = 'webcodecs' | 'ffmpeg';

export interface HybridEncodeResult {
  blob: Blob;
  path: EncoderPath;
}

/**
 * Merge clips using the best available encoder.
 *
 * @param clips       - Ordered list of clips to merge
 * @param transitions - Optional transitions between clips
 * @param settings    - Export quality settings
 * @param onStatus    - Status callback for progress updates
 * @param forceFFmpeg - Set to true to bypass WebCodecs detection
 */
export async function hybridMergeClips(
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  forceFFmpeg = false,
): Promise<HybridEncodeResult> {
  const useWebCodecs = !forceFFmpeg && (await isWebCodecsAvailable());

  if (useWebCodecs) {
    // Check if transitions are active — WebCodecs path doesn't support them
    const hasActiveTransitions = transitions.some((t) => t.type !== 'none' && t.duration > 0);
    if (!hasActiveTransitions) {
      try {
        onStatus('GPU path selected (WebCodecs + hardware H.264)...');
        const blob = await encodeClipsWithWebCodecs(clips, settings, onStatus);
        return { blob, path: 'webcodecs' };
      } catch (err) {
        onStatus(
          `GPU encode failed (${(err as Error).message}). Falling back to FFmpeg...`,
        );
      }
    }
  }

  const blob = await mergeClips(clips, transitions, settings, onStatus);
  return { blob, path: 'ffmpeg' };
}
