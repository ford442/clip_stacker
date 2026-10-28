/**
 * Project serialization, deserialization, and remote storage.
 *
 * Implementation is split across `project/` submodules; this file re-exports
 * the public API so existing import paths remain stable.
 *
 * `getClipDuration` and `DEFAULT_CANVAS_*` are re-exported for compatibility
 * only: import them from `./clipTiming` / `./canvasDefaults`. This barrel
 * pulls in project load, which imports the timeline modules, so using it for
 * those helpers creates import cycles (`npm run check:cycles`).
 */

export {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  CHUNK_THRESHOLD_BYTES,
  MAX_UPLOAD_RETRY_ATTEMPTS,
  MAX_EMBED_FILE_BYTES,
  MAX_MEDIA_DOWNLOAD_ATTEMPTS,
} from './project/constants';

export { getClipDuration } from './clipTiming';

export {
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
  ContaboJob,
  ContaboJobRequest,
  ContaboJobResult,
  ContaboJobSource,
  ContaboJobStatus,
  ContaboJobType,
} from './project/contaboJobs';

export type {
  RemoteUploadProgressEvent,
  RemoteUploadErrorEvent,
  AppliedProjectData,
  RemoteProjectLoadProgressEvent,
  MediaLibraryItem,
} from './project/types';
