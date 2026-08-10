export {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
} from '../constants';

/** Re-export chunk threshold so callers/tests can assert the fast-path cutoff. */
export { CHUNK_THRESHOLD_BYTES } from '../storageUpload';

/** Maximum number of upload attempts per clip before aborting the save. */
export const MAX_UPLOAD_RETRY_ATTEMPTS = 5;

/**
 * Maximum source file size (in bytes) that will be embedded as a base64
 * data URL in a project JSON. Base64 inflates size by ~33%, and the
 * resulting JSON string must still fit comfortably in browser memory and
 * (if ever persisted) `localStorage`'s ~5-10MB quota. Files larger than
 * this are either uploaded to remote storage (if a media client is
 * available) or left out of the embed with a warning.
 */
export const MAX_EMBED_FILE_BYTES = 8 * 1024 * 1024;

/** Number of attempts (including the first) for downloading remote media. */
export const MAX_MEDIA_DOWNLOAD_ATTEMPTS = 3;

/** Delay (ms) before retrying a failed media download, multiplied by the attempt number. */
export const MEDIA_DOWNLOAD_RETRY_DELAY_MS = 500;

export const REMOTE_PROJECT_DOWNLOAD_PROGRESS_START = 0.08;
export const REMOTE_PROJECT_DOWNLOAD_PROGRESS_END = 0.96;

export const FADE_SAFETY_MARGIN = 0.01;
