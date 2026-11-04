/**
 * Types and interfaces for canvas rendering.
 */

export interface RendererOptions {
  /** Output canvas width in pixels (default 1280). */
  width?: number;
  /** Output canvas height in pixels (default 720). */
  height?: number;
  /** Target frames per second used for end-of-clip detection (default 30). */
  fps?: number;
  /**
   * Enable audio-reactive visual effects.
   * When true, bass-frequency energy drives a subtle warm glow overlay.
   */
  audioReactive?: boolean;
}

export interface RenderProgress {
  clipIndex: number;
  totalClips: number;
  clipTitle: string;
  /** Seconds elapsed within the current clip. */
  clipElapsed: number;
  /** Seconds elapsed across the full render. */
  totalElapsed: number;
}

export type ProgressCallback = (progress: RenderProgress) => void;

/** A decoded drawable plus its intrinsic dimensions, keyed by clip id. */
export interface FrameSource {
  image: CanvasImageSource;
  /** Intrinsic source width (e.g. video.videoWidth). */
  width: number;
  /** Intrinsic source height (e.g. video.videoHeight). */
  height: number;
}
