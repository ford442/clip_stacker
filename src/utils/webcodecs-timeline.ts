/** Frame rate used for timeline WebCodecs export (matches `TARGET_FPS` in webcodecs.ts). */
export const TIMELINE_EXPORT_FPS = 30;

/** Minimum interval between `onStatus` updates during timeline export. */
export const TIMELINE_STATUS_THROTTLE_MS = 250;

/** Encoded chunks allowed in flight before pausing frame submission. */
export const MAX_ENCODE_QUEUE_DEPTH = 16;

/**
 * Exact, reproducible frame count for a timeline export at the given fps.
 * `frameIndex` runs `0 .. totalFrames - 1`; sampling time is `frameIndex / fps`.
 */
export function computeTimelineExportFrameCount(
  totalDurationSec: number,
  fps: number = TIMELINE_EXPORT_FPS,
): number {
  if (totalDurationSec <= 0 || fps <= 0) return 0;
  return Math.round(totalDurationSec * fps);
}

/** Presentation time in seconds for a zero-based export frame index. */
export function globalTimeForTimelineFrame(
  frameIndex: number,
  fps: number = TIMELINE_EXPORT_FPS,
): number {
  return frameIndex / fps;
}

/** Microseconds timestamp handed to VideoEncoder for `frameIndex`. */
export function timelineFrameTimestampUs(
  frameIndex: number,
  fps: number = TIMELINE_EXPORT_FPS,
): number {
  const frameDurationUs = Math.round(1_000_000 / fps);
  return frameIndex * frameDurationUs;
}

/** Minimum frames between throttled status updates (~4 Hz at 30 fps / 250 ms). */
export function timelineStatusThrottleFrames(
  fps: number = TIMELINE_EXPORT_FPS,
  intervalMs: number = TIMELINE_STATUS_THROTTLE_MS,
): number {
  return Math.max(1, Math.round((fps * intervalMs) / 1000));
}

/**
 * Whether to emit an `onStatus` string for this frame. Progress callbacks may
 * still fire every frame for a smooth bar.
 */
export function shouldEmitTimelineStatusUpdate(
  frameIndex: number,
  lastEmittedFrameIndex: number,
  throttleFrames: number,
  totalFrames: number,
): boolean {
  if (totalFrames <= 0) return false;
  if (frameIndex === 0 || frameIndex >= totalFrames - 1) return true;
  return frameIndex - lastEmittedFrameIndex >= throttleFrames;
}

/** True when the encoder queue is deeper than the configured backpressure limit. */
export function shouldWaitForEncoderBackpressure(
  encodeQueueSize: number,
  maxDepth: number = MAX_ENCODE_QUEUE_DEPTH,
): boolean {
  return encodeQueueSize > maxDepth;
}
