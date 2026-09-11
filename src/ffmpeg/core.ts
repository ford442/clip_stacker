// Barrel module: re-exports the FFmpeg render pipeline's public surface.
// Split by responsibility across sibling modules — see each file for detail:
//   coreRuntime.ts    - FFmpeg instance/log/error plumbing, fonts, blob URLs
//   clipFilters.ts    - per-clip predicates and filter_complex/CLI builders
//   mergeLossless.ts  - fast-path (stream copy) concat render
//   twoPassEncode.ts  - two-pass re-encode render (fades/effects/loops)
//   mergeTransitions.ts - xfade/acrossfade transition render
export {
  buildDrawtextFilter,
  buildSilentAacLoopInputArgs,
  ensureSilentAacUnit,
  SILENT_AAC_UNIT_NAME,
  FfmpegManager,
  getFfmpegManager,
  setFfmpegManagerForTesting,
  resetFfmpegManagerForTesting,
  FONT_CDN_URL,
  FONT_VIRTUAL_NAME,
  isFfmpegLoadFailed,
  isFfmpegLoading,
  recordFfmpegLog,
  getLastFfmpegLogs,
  getLastFfmpegError,
  getLastFfmpegCommand,
  getLastFfmpegFilterComplex,
  clearFfmpegLogs,
  MAX_LOG_BUFFER,
  buildDetailedError,
  extractErrorMessage,
  normalizeError,
  clampProgress,
  emitProgress,
  emitLoadStatus,
  getCdnLabel,
  getLocalFfmpegCoreBaseURL,
  getFfmpegCoreSources,
  buildFfmpegLoadErrorMessage,
  parseFfmpegTimeSeconds,
  getFfmpegEnvironmentDiagnostics,
  withTimeout,
  FFMPEG_CORE_CDNS,
  FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
  FFMPEG_LOAD_TIMEOUT_MS,
  toBlobURLWithRetry,
  toBlobURLWithFallback,
  safeExec,
  safeWriteFile,
  prepareSecondaryColorFfmpeg,
  safeReadFile,
  execWithFfmpegProgress,
  ensureFfmpeg,
  ensureFont,
  ensureFontsForOverlays,
  appendTextOverlayFilters,
  aggressiveCleanupFFmpegVFS,
  resetFFmpegInstance,
  NO_AUDIO_STREAM_RE,
  isNoAudioStreamError,
  isNoVideoStreamError,
} from "./coreRuntime";
export type {
  FfmpegLogProgressContext,
  ProgressCallback,
  RenderProgressUpdate,
  StatusCallback,
  IFfmpegRuntime,
} from "./coreRuntime";

export {
  DEFAULT_VIDEO_SIZE,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  PASS1_PROGRESS_START,
  PASS1_PROGRESS_END,
} from "./coreConstants";

export {
  clipNeedsEffects,
  STILL_IMAGE_OUTPUT_FPS,
  isStillImageClip,
  clipHasSourceAudio,
  clipHasSourceVideo,
  clipNeedsLoopInput,
  resolveStillImageEncodeDimensions,
  buildStillImageVideoFilter,
  clipIsOverlayLayer,
  buildStillImageFfmpegArgs,
  buildStillImageFfmpegArgsForClip,
  buildClipInputArgs,
  getSafeExtension,
  buildSingleClipFilter,
} from "./clipFilters";
export type {
  StillImageFilterOptions,
  StillImageEncodeOptions,
} from "./clipFilters";

export { mergeClipsLossless } from "./mergeLossless";
export {
  performTwoPassEncode,
  processClipPass1,
  mergeClipsPass2,
} from "./twoPassEncode";
export { mergeClipsWithTransitions } from "./mergeTransitions";
