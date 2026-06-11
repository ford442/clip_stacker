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

export async function muxProcessedVideoWithSourceAudio(
  videoBlob: Blob,
  clip: Clip,
  onStatus: StatusCallback,
): Promise<Blob> {
  clearFfmpegLogs();

  if (clip.kind !== "video") {
    throw new Error(
      "Cannot mux processed video with audio from a non-video clip.",
    );
  }

  const ffmpeg = await ensureFfmpeg(onStatus);
  const videoExt = videoBlob.type.includes("webm") ? "webm" : "mp4";
  const videoInputName = `processed-video.${videoExt}`;
  const sourceExt = getSafeExtension(clip.file.name, "mp4");
  const sourceInputName = `source-audio.${sourceExt}`;
  const outputName = "processed-with-audio.mp4";
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;

  for (const name of [videoInputName, sourceInputName, outputName]) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }

  onStatus(`Restoring source audio for "${clip.title}"...`);

  try {
    await safeWriteFile(
      ffmpeg,
      videoInputName,
      new Uint8Array(await videoBlob.arrayBuffer()),
      "processed video write input",
    );
    await safeWriteFile(
      ffmpeg,
      sourceInputName,
      await fetchFile(clip.file),
      "processed video write source audio",
    );

    const filterComplex = `[1:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS[aout]`;

    await safeExec(
      ffmpeg,
      [
        "-i",
        videoInputName,
        "-i",
        sourceInputName,
        "-filter_complex",
        filterComplex,
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        outputName,
      ],
      null,
      `Mux processed video with source audio for "${clip.title}"`,
    );

    const output = await safeReadFile(
      ffmpeg,
      outputName,
      "processed video read output",
    );
    const plain = new Uint8Array(output).buffer as ArrayBuffer;

    onStatus("Source audio restored.");
    return new Blob([plain], { type: "video/mp4" });
  } finally {
    try {
      await ffmpeg.deleteFile(videoInputName);
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile(sourceInputName);
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
 * Analyze clips, transitions, and overlays to determine which rendering path will be used.
 * Returns a description of the plan and whether re-encoding will occur.
 *
 * Decision logic (in order):
 * 1. If any clip has layerIndex > 0 → PiP/compositing (re-encode)
 * 2. If any transitions are active → transitions path (re-encode)
 * 3. If any text overlays → text overlays path (re-encode)
 * 4. If any clip needs effects (fades, audio-only, or RIFE) → two-pass re-encode
 * 5. Otherwise → lossless concat (fast, no quality loss)
 */
