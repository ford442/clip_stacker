/**
 * Project serialization, deserialization, and remote storage.
 *
 * Implementation is split across `project/` submodules; this file re-exports
 * the public API so existing import paths remain stable.
 */

export {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  CHUNK_THRESHOLD_BYTES,
  MAX_UPLOAD_RETRY_ATTEMPTS,
  MAX_EMBED_FILE_BYTES,
  MAX_MEDIA_DOWNLOAD_ATTEMPTS,
} from './project/constants';

export {
  getClipDuration,
  clampOverlayPosition,
  isOverlayOffCanvas,
  sanitizeClipAdjustments,
} from './project/clipHelpers';

export { serializeProject } from './project/serialize';

export {
  serializeProjectWithMedia,
} from './project/serializeWithMedia';

export { downloadRemoteMedia, formatBytes } from './project/remoteMedia';

export { applyProjectData } from './project/applyProjectData';

export { loadRemoteProject } from './project/loadRemoteProject';

export { ContaboStorageManagerClient } from './project/contaboClient';

export type {
  RemoteUploadProgressEvent,
  RemoteUploadErrorEvent,
  AppliedProjectData,
  RemoteProjectLoadProgressEvent,
  MediaLibraryItem,
} from './project/types';
