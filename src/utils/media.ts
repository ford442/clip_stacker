export const MIN_CLIP_DURATION = 0.1;

const MEDIA_LOAD_TIMEOUT_MS = 5000;

export interface MediaInfo {
  duration: number;
  objectUrl: string;
  videoWidth?: number;
  videoHeight?: number;
}

function loadMediaInfo(file: File, includeUrl: true): Promise<MediaInfo>;
function loadMediaInfo(file: File, includeUrl: false): Promise<number>;
function loadMediaInfo(file: File, includeUrl: boolean): Promise<MediaInfo | number> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const mediaElement = file.type.startsWith('video/')
      ? document.createElement('video')
      : document.createElement('audio');
    mediaElement.src = objectUrl;
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      mediaElement.removeEventListener('loadedmetadata', onLoadedMetadata);
      mediaElement.removeEventListener('error', onError);
      mediaElement.src = '';
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
      reject(new Error('Could not load media duration'));
    };

    mediaElement.addEventListener('loadedmetadata', onLoadedMetadata);
    mediaElement.addEventListener('error', onError);
    timeoutId = setTimeout(() => {
      if (!isNaN(mediaElement.duration) && mediaElement.duration > 0) {
        onLoadedMetadata();
      } else {
        onError();
      }
    }, MEDIA_LOAD_TIMEOUT_MS);
  });
}

export function getMediaInfo(file: File): Promise<MediaInfo> {
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

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';

    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) { resolve([]); return; }

    const end = isNaN(trimEnd) ? duration : Math.min(trimEnd, duration);
    const start = Math.max(0, trimStart);
    const range = Math.max(0.1, end - start);
    const times = Array.from({ length: count }, (_, j) =>
      start + (range * (j + 0.5)) / count,
    );

    const thumbnails: string[] = [];
    let frameIndex = 0;
    let done = false;
    let seekTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const overallTimeout = setTimeout(() => finish(), 30_000);

    function finish() {
      if (done) return;
      done = true;
      if (seekTimeoutId) clearTimeout(seekTimeoutId);
      clearTimeout(overallTimeout);
      video.src = '';
      resolve(thumbnails);
    }

    function captureFrame() {
      try {
        ctx!.drawImage(video, 0, 0, THUMB_W, THUMB_H);
        thumbnails.push(canvas.toDataURL('image/jpeg', 0.5));
      } catch { /* skip frame on error */ }
    }

    function seekToNext() {
      if (frameIndex >= times.length) { finish(); return; }
      if (seekTimeoutId) clearTimeout(seekTimeoutId);
      seekTimeoutId = setTimeout(() => {
        captureFrame();
        frameIndex++;
        seekToNext();
      }, 1500);
      video.currentTime = times[frameIndex];
    }

    video.addEventListener('error', finish);
    video.addEventListener('loadedmetadata', () => seekToNext(), { once: true });
    video.addEventListener('seeked', () => {
      if (done) return;
      if (seekTimeoutId) clearTimeout(seekTimeoutId);
      captureFrame();
      frameIndex++;
      seekToNext();
    });

    video.src = objectUrl;
  });
}
