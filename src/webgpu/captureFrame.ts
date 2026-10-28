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

/** A frame of a decoded still, drawn through a 2D canvas (timestamp 0). */
export async function captureStillFrame(img: HTMLImageElement): Promise<VideoFrame | null> {
  if (!img.complete || img.naturalWidth <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return new VideoFrame(canvas, { timestamp: 0 });
  } catch {
    return null;
  }
}
