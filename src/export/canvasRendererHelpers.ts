/**
 * Helper functions for canvas-based rendering operations.
 */

/** Calculate the letterbox rectangle for a video within a canvas. */
export function calculateLetterboxRect(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  const videoAspect = videoWidth / videoHeight;
  const canvasAspect = canvasWidth / canvasHeight;
  let destWidth: number;
  let destHeight: number;
  if (videoAspect > canvasAspect) {
    destWidth = canvasWidth;
    destHeight = canvasWidth / videoAspect;
  } else {
    destHeight = canvasHeight;
    destWidth = canvasHeight * videoAspect;
  }
  return {
    x: (canvasWidth - destWidth) / 2,
    y: (canvasHeight - destHeight) / 2,
    width: destWidth,
    height: destHeight,
  };
}

/** Compute the opacity alpha based on fade in/out timings. */
export function computeFadeAlpha(
  elapsed: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
): number {
  let alpha = 1;
  if (fadeIn > 0 && elapsed < fadeIn) alpha = Math.min(alpha, elapsed / fadeIn);
  if (fadeOut > 0 && elapsed > duration - fadeOut)
    alpha = Math.min(alpha, (duration - elapsed) / fadeOut);
  return Math.max(0, Math.min(1, alpha));
}

/** Clamp a value to the [0, 1] opacity range. */
export function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Wait for a video element's seek operation to complete. */
export function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && !video.seeking) {
      resolve();
      return;
    }
    const onSeeked = () => {
      off();
      resolve();
    };
    const onError = () => {
      off();
      reject(new Error("Video seek failed"));
    };
    const off = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}
