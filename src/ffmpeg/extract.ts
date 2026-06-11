import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type {
  Clip,
  ExportSettings,
  ClipTransition,
  TextOverlay,
  RenderPlan,
} from "../types";
import { DEFAULT_EXPORT_SETTINGS } from "../types";
import { getClipDuration } from "../utils/project";
import { buildTransitionFilterComplex } from "../utils/transitions";
import {
  isFfmpegLoadFailed,
  isFfmpegLoading,
  recordFfmpegLog,
  getLastFfmpegLogs,
  getLastFfmpegError,
  clearFfmpegLogs,
  buildDetailedError,
  extractErrorMessage,
  clampProgress,
  emitProgress,
  emitLoadStatus,
  getCdnLabel,
  getLocalFfmpegCoreBaseURL,
  getFfmpegCoreSources,
  terminateFfmpegInstance,
  clearTrackedLoadingInstance,
  buildFfmpegLoadErrorMessage,
  parseFfmpegTimeSeconds,
  safeExec,
  safeWriteFile,
  safeReadFile,
  execWithFfmpegProgress,
  clipNeedsEffects,
  getSafeExtension,
  buildSingleClipFilter,
  getFfmpegEnvironmentDiagnostics,
  toBlobURLWithRetry,
  toBlobURLWithFallback,
  withTimeout,
  _doLoadFfmpeg,
  ensureFfmpeg,
  ensureFont,
  buildDrawtextFilter,
  mergeClipsLossless,
  performTwoPassEncode,
  processClipPass1,
  mergeClipsPass2,
  mergeClipsWithTransitions,
  DEFAULT_VIDEO_SIZE,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  PASS1_PROGRESS_START,
  PASS1_PROGRESS_END,
  FONT_CDN_URL,
  FONT_VIRTUAL_NAME,
  ffmpegInstance,
  fontLoaded,
  ffmpegLoadingInstance,
  ffmpegLoadingPromise,
  ffmpegLoadFailed,
  loadGeneration,
  StatusCallback,
  RenderProgressUpdate,
  ProgressCallback,
  FfmpegLogProgressContext,
  activeFfmpegLogProgress,
  MAX_LOG_BUFFER,
  ffmpegLogBuffer,
  lastFfmpegErrorLog,
  FFMPEG_CORE_CDNS,
  FFMPEG_CORE_DOWNLOAD_TIMEOUT_MS,
  FFMPEG_LOAD_TIMEOUT_MS,
} from "./core";

export async function extractTrimmedVideoClip(
  clip: Clip,
  onStatus: StatusCallback,
): Promise<Blob> {
  clearFfmpegLogs();

  const ffmpeg = await ensureFfmpeg(onStatus);

  const ext = getSafeExtension(clip.file.name, "mp4");
  const inputName = `rife-input.${ext}`;
  const outputName = "rife-trimmed.mp4";

  const dur = getClipDuration(clip);
  if (dur <= 0) {
    throw new Error(
      "Cannot extract trimmed clip: clip has zero or negative duration after trim.",
    );
  }

  for (const name of [inputName, outputName]) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }

  onStatus(`Preparing trimmed segment of "${clip.title}" for RIFE…`);

  try {
    await safeWriteFile(
      ffmpeg,
      inputName,
      await fetchFile(clip.file),
      "rife trim write input",
    );

    const args: string[] = [];
    if (clip.trimStart > 0) args.push("-ss", String(clip.trimStart));
    args.push("-i", inputName);
    if (Number.isFinite(clip.trimEnd)) {
      args.push("-t", String(clip.trimEnd - clip.trimStart));
    }
    args.push("-c", "copy", "-avoid_negative_ts", "make_zero", outputName);

    await safeExec(
      ffmpeg,
      args,
      null,
      `RIFE trim for "${clip.title}" (${clip.trimStart}-${clip.trimEnd || "end"})`,
    );

    const output = await safeReadFile(
      ffmpeg,
      outputName,
      "rife trim read output",
    );
    const plain = new Uint8Array(output).buffer as ArrayBuffer;

    onStatus("Trimmed segment ready.");
    return new Blob([plain], { type: "video/mp4" });
  } finally {
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Attach the original clip audio (respecting the clip's current trim window) to
 * a processed video blob, such as a RIFE-interpolated segment that no longer
 * carries its own audio stream.
 */
