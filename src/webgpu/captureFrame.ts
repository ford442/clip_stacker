/**
 * Main-thread `VideoFrame` capture from media elements — shared by the
 * main-thread compositor (export) and the preview worker adapter's
 * element-fallback layers, so both read pixels the same way.
 */

/** A frame of the `<video>`'s current picture, or null before it has one. */
export async function captureVideoFrame(video: HTMLVideoElement): Promise<VideoFrame | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  try {
    return new VideoFrame(video);
  } catch {
    return null;
  }
}

/**
 * One decoded `VideoFrame` per still `<img>` (and its `src`): a still layer
 * used to be redrawn through a fresh 2D canvas every frame. Released with
 * the media pool's element ({@link releaseStillFrame}).
 */
const stillFrames = new WeakMap<HTMLImageElement, { src: string; frame: VideoFrame }>();

/**
 * A frame of a decoded still (timestamp 0). The caller owns and closes the
 * returned frame — a clone of the cached one, so the pixels are drawn once.
 */
export async function captureStillFrame(img: HTMLImageElement): Promise<VideoFrame | null> {
  if (!img.complete || img.naturalWidth <= 0) return null;
  const cached = stillFrames.get(img);
  if (cached && cached.src === img.src) {
    try {
      return cached.frame.clone();
    } catch {
      // Closed elsewhere: draw it again below.
    }
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    releaseStillFrame(img);
    stillFrames.set(img, { src: img.src, frame });
    return frame.clone();
  } catch {
    return null;
  }
}

/** Close the cached frame of `img` (the media pool calls this when it drops the element). */
export function releaseStillFrame(img: HTMLImageElement): void {
  const cached = stillFrames.get(img);
  if (!cached) return;
  stillFrames.delete(img);
  try {
    cached.frame.close();
  } catch {
    // Already closed.
  }
}
