import { seekToFrame } from "./videoFrameCapture";

export const MIN_CLIP_DURATION = 0.1;

/** Default on-timeline duration when importing a still image (seconds). */
export const STILL_IMAGE_DEFAULT_DURATION = 5;

const MEDIA_LOAD_TIMEOUT_MS = 5000;

export interface MediaInfo {
  duration: number;
  objectUrl: string;
  videoWidth?: number;
  videoHeight?: number;
}

function loadMediaInfo(file: File, includeUrl: true): Promise<MediaInfo>;
function loadMediaInfo(file: File, includeUrl: false): Promise<number>;
function loadMediaInfo(
  file: File,
  includeUrl: boolean,
): Promise<MediaInfo | number> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const mediaElement = file.type.startsWith("video/")
      ? document.createElement("video")
      : document.createElement("audio");
    mediaElement.src = objectUrl;
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      mediaElement.removeEventListener("loadedmetadata", onLoadedMetadata);
      mediaElement.removeEventListener("error", onError);
      mediaElement.src = "";
    };

    const onLoadedMetadata = () => {
      if (resolved) return;
      resolved = true;
      const duration = mediaElement.duration;
      const videoWidth =
        mediaElement instanceof HTMLVideoElement && mediaElement.videoWidth > 0
          ? mediaElement.videoWidth
          : undefined;
      const videoHeight =
        mediaElement instanceof HTMLVideoElement && mediaElement.videoHeight > 0
          ? mediaElement.videoHeight
          : undefined;
      cleanup();
      if (includeUrl) {
        resolve({ duration, objectUrl, videoWidth, videoHeight });
      } else {
        URL.revokeObjectURL(objectUrl);
        resolve(duration);
      }
    };

    const onError = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not load media duration"));
    };

    mediaElement.addEventListener("loadedmetadata", onLoadedMetadata);
    mediaElement.addEventListener("error", onError);
    timeoutId = setTimeout(() => {
      if (!isNaN(mediaElement.duration) && mediaElement.duration > 0) {
        onLoadedMetadata();
      } else {
        onError();
      }
    }, MEDIA_LOAD_TIMEOUT_MS);
  });
}

function isImageFile(file: File): boolean {
  return (
    file.type.startsWith('image/') ||
    /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name)
  );
}

function loadImageInfo(file: File): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    const onLoad = () => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve({
        duration: STILL_IMAGE_DEFAULT_DURATION,
        objectUrl,
        videoWidth: img.naturalWidth,
        videoHeight: img.naturalHeight,
      });
    };
    const onError = () => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not load image'));
    };
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
    img.src = objectUrl;
  });
}

export function getMediaInfo(file: File): Promise<MediaInfo> {
  if (isImageFile(file)) return loadImageInfo(file);
  return loadMediaInfo(file, true);
}

export function getMediaDuration(file: File): Promise<number> {
  return loadMediaInfo(file, false);
}

export function createClipId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}

const THUMB_W = 96;
const THUMB_H = 54;

export async function extractThumbnails(
  objectUrl: string,
  duration: number,
  trimStart: number,
  trimEnd: number,
  count: number,
): Promise<string[]> {
  if (count <= 0) return [];

  const canvas = document.createElement("canvas");
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  // crossOrigin lets us draw (and read back via toDataURL) frames from remote
  // storage URLs without tainting the canvas; harmless for blob: URLs.
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  // An offscreen-but-rendered element keeps the decoder delivering frames
  // (display:none / detached elements can stop frame delivery in Chromium).
  video.style.cssText =
    "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;";
  document.body.appendChild(video);
  video.src = objectUrl;

  const end = isNaN(trimEnd) ? duration : Math.min(trimEnd, duration);
  const start = Math.max(0, trimStart);
  const range = Math.max(0.1, end - start);
  const times = Array.from(
    { length: count },
    (_, j) => start + (range * (j + 0.5)) / count,
  );

  const thumbnails: string[] = [];
  try {
    await waitForVideoReady(video);
    for (const t of times) {
      const ready = await seekToFrame(video, t);
      if (!ready) continue;
      try {
        ctx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
        thumbnails.push(canvas.toDataURL("image/jpeg", 0.5));
      } catch {
        /* skip frame on draw/readback error */
      }
    }
  } catch {
    /* metadata never loaded — return whatever we captured */
  } finally {
    video.removeAttribute("src");
    video.load();
    if (video.parentElement) video.parentElement.removeChild(video);
  }

  return thumbnails;
}

/** Resolve once the video has enough data to seek/draw, or reject on error. */
function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load video for thumbnails"));
    };
    const timeoutId = setTimeout(() => {
      if (video.readyState >= 2) onReady();
      else onError();
    }, MEDIA_LOAD_TIMEOUT_MS);
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}
