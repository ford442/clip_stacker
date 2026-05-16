export const MIN_CLIP_DURATION = 0.1;

const MEDIA_LOAD_TIMEOUT_MS = 5000;

export interface MediaInfo {
  duration: number;
  objectUrl: string;
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
      cleanup();
      if (includeUrl) {
        resolve({ duration, objectUrl });
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
