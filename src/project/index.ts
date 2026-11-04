/**
 * Project serialization, deserialization, and remote storage.
 *
 * Implementation is split across `project/` submodules; this file re-exports
 * the public API so existing import paths remain stable.
 *
 * `getClipDuration` and `DEFAULT_CANVAS_*` are re-exported for compatibility
 * only: import them from `../timeline/clipTiming` / `../utils/canvasDefaults`. This barrel
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
} from './constants';

export { getClipDuration } from '../timeline/clipTiming';

export {
  clampOverlayPosition,
  isOverlayOffCanvas,
  sanitizeClipAdjustments,
} from './clipHelpers';

export { serializeProject, type SerializeProjectOptions } from './serialize';

export {
  createProjectSnapshot,
  projectSnapshotHasContent,
  selectProjectSnapshot,
  selectProjectSnapshotEditorFields,
  type ProjectSnapshot,
} from './snapshot';

export {
  serializeProjectWithMedia,
  type SerializeProjectWithMediaOptions,
} from './serializeWithMedia';

export { downloadRemoteMedia, formatBytes } from './remoteMedia';

export { applyProjectData } from './applyProjectData';

export { loadRemoteProject } from './loadRemoteProject';

export { ContaboStorageManagerClient } from './contaboClient';
export type {
  ContaboJob,
  ContaboJobRequest,
  ContaboJobResult,
  ContaboJobSource,
  ContaboJobStatus,
  ContaboJobType,
} from './contaboJobs';

export type {
  RemoteUploadProgressEvent,
  RemoteUploadErrorEvent,
  AppliedProjectData,
  RemoteProjectLoadProgressEvent,
  MediaLibraryItem,
} from './types';
