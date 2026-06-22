/**
 * Frame-accurate seeking for hidden <video> decoders.
 *
 * Every preview surface (inspector thumbnails, fade previews, the timeline
 * compositor) used to seek a <video> and draw it on the `seeked` event. But
 * `seeked` fires when the *seek completes*, not when the decoded frame is
 * actually presentable to `drawImage` / `new VideoFrame(video)`. On Chromium in
 * particular the freshly-seeked pixels are frequently not uploadable yet at that
 * moment, so drawing on `seeked` yields blank, black, or stale frames.
 *
 * `requestVideoFrameCallback` (rVFC) fixes this: it only fires once a new frame
 * has been *presented to the compositor*, which is exactly the signal we need.
 * We arm the callback before triggering the seek so we catch the presentation
 * the seek produces, and fall back to the `seeked` event on browsers without
 * rVFC.
 */

declare global {
  interface HTMLVideoElement {
    requestVideoFrameCallback(
      callback: (now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => void,
    ): number;
    cancelVideoFrameCallback(handle: number): void;
  }
}

/** A current-time delta this small is treated as "already on the target frame". */
export const FRAME_SEEK_TOLERANCE = 0.04;

/** Default ceiling on how long to wait for a seeked frame before giving up. */
export const FRAME_SEEK_TIMEOUT_MS = 2500;

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — a frame for the current position exists. */
const HAVE_CURRENT_DATA = 2;

/**
 * Seek `video` to `time` and resolve only once a frame for that position has
 * actually been decoded and presented (so it is safe to `drawImage` it).
 *
 * @returns `true` when a presentable frame is ready, `false` on error/timeout
 *          (the caller should skip drawing this frame).
 */
export function seekToFrame(
  video: HTMLVideoElement,
  time: number,
  timeoutMs: number = FRAME_SEEK_TIMEOUT_MS,
): Promise<boolean> {
  const target = Math.max(0, time);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let rvfcHandle = 0;
    let timeoutId: ReturnType<typeof setTimeout>;
    const hasRvfc = typeof video.requestVideoFrameCallback === "function";

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      video.removeEventListener("error", onError);
      video.removeEventListener("seeked", onSeeked);
      if (rvfcHandle && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      resolve(ok);
    };

    const onError = () => finish(false);
    // Fallback path (no rVFC): a frame is normally drawable right after `seeked`.
    const onSeeked = () => finish(video.readyState >= HAVE_CURRENT_DATA);

    timeoutId = setTimeout(
      () => finish(video.readyState >= HAVE_CURRENT_DATA),
      timeoutMs,
    );
    video.addEventListener("error", onError, { once: true });

    // Already parked on the target frame — it is already presentable, and a
    // paused video will not present a *new* frame, so don't wait for rVFC.
    const alreadyOnFrame =
      Math.abs(video.currentTime - target) <= FRAME_SEEK_TOLERANCE &&
      !video.seeking &&
      video.readyState >= HAVE_CURRENT_DATA;
    if (alreadyOnFrame) {
      finish(true);
      return;
    }

    video.pause();

    // Arm the frame callback *before* triggering the seek so we observe the
    // frame the seek presents rather than missing it and waiting for a next one
    // that never comes on a paused element.
    if (hasRvfc) {
      rvfcHandle = video.requestVideoFrameCallback(() => finish(true));
    } else {
      video.addEventListener("seeked", onSeeked, { once: true });
    }

    try {
      video.currentTime = target;
    } catch {
      finish(false);
    }
  });
}
