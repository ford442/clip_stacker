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
import { audioVolumeFilterSegment } from "../utils/audioVolume";
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

export async function muxVideoWithAudio(
  videoBlob: Blob,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (clips.length === 0)
    throw new Error("No clips provided for audio muxing.");

  const ffmpeg = await ensureFfmpeg(onStatus, onProgress);
  onStatus("Preparing audio mux...");
  emitProgress(onProgress, "Audio mux preparation", 0.86, false);

  // Clean up any leftover files from a previous mux run.
  for (const entry of await ffmpeg.listDir("/")) {
    if (entry.isDir) continue;
    if (
      entry.name.startsWith("mux_audio_") ||
      entry.name === "mux_canvas_video.mp4" ||
      entry.name === "mux_canvas_video.webm" ||
      entry.name === "mux_output.mp4"
    ) {
      await ffmpeg.deleteFile(entry.name);
    }
  }

  // Write the canvas-captured video to the virtual filesystem.
  const videoExt = videoBlob.type.includes("mp4") ? "mp4" : "webm";
  const videoVfsName = `mux_canvas_video.${videoExt}`;
  onStatus("Writing canvas video to FFmpeg...");
  await safeWriteFile(
    ffmpeg,
    videoVfsName,
    new Uint8Array(await videoBlob.arrayBuffer()),
    "mux write canvas video",
  );

  // Write each clip's source file for audio extraction.
  const audioVfsNames: string[] = [];
  for (const [i, clip] of clips.entries()) {
    const ext = getSafeExtension(
      clip.file.name,
      clip.kind === "video" ? "mp4" : "mp3",
    );
    const name = `mux_audio_${i}.${ext}`;
    await safeWriteFile(
      ffmpeg,
      name,
      await fetchFile(clip.file),
      `mux write audio ${i}`,
    );
    audioVfsNames.push(name);
    const prepProgress = 0.87 + ((i + 1) / clips.length) * 0.04;
    emitProgress(onProgress, "Audio mux preparation", prepProgress, false);
  }

  // Build a filter_complex that trims, fades, and concatenates all audio tracks.
  // Input 0 is the canvas video; inputs 1..N are the clip files for audio.
  const filterParts: string[] = [];
  const streamLabels: string[] = [];

  for (const [i, clip] of clips.entries()) {
    const inputIdx = i + 1; // 0 = canvas video
    const trimStart = clip.trimStart;
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const duration = getClipDuration(clip);
    const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);

    let af = `[${inputIdx}:a]atrim=start=${trimStart}:end=${end},asetpts=PTS-STARTPTS`;
    if (clip.audioFadeIn > 0) af += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0)
      af += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    af += audioVolumeFilterSegment(clip.volume ?? 1);
    const label = `[amux${i}]`;
    af += label;
    filterParts.push(af);
    streamLabels.push(label);
  }

  filterParts.push(
    `${streamLabels.join("")}concat=n=${streamLabels.length}:v=0:a=1[aout]`,
  );

  const filterComplex = filterParts.join(";");

  // Build the ffmpeg argument list.
  const inputArgs: string[] = ["-i", videoVfsName];
  for (const name of audioVfsNames) {
    inputArgs.push("-i", name);
  }

  onStatus("Muxing audio with canvas video...");
  const totalDuration = clips.reduce(
    (sum, clip) => sum + getClipDuration(clip),
    0,
  );
  await safeExec(
    ffmpeg,
    [
      ...inputArgs,
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "copy", // preserve the canvas-captured video as-is
      "-c:a",
      "aac",
      "-b:a",
      "192k", // ExportSettings has no audioBitrate field; 192 kbps matches the existing FFmpeg path
      "-movflags",
      "+faststart",
      "mux_output.mp4",
    ],
    {
      stage: "Muxing audio with canvas video",
      totalDuration,
      rangeStart: 0.91,
      rangeEnd: 0.995,
      onProgress,
    },
    "Canvas video + audio mux exec",
  );

  const output = await safeReadFile(ffmpeg, "mux_output.mp4", "mux final read");
  const plain = new Uint8Array(output).buffer as ArrayBuffer;

  // Clean up.
  try {
    await ffmpeg.deleteFile(videoVfsName);
  } catch {
    /* ignore */
  }
  for (const name of audioVfsNames) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }
  try {
    await ffmpeg.deleteFile("mux_output.mp4");
  } catch {
    /* ignore */
  }

  onStatus("Audio mux complete.");
  emitProgress(onProgress, "Audio mux complete", 1, false);
  return new Blob([plain], { type: "video/mp4" });
}

// ---------------------------------------------------------------------------
// Memory management and cleanup
// ---------------------------------------------------------------------------

/**
 * Aggressively clean up the FFmpeg virtual filesystem.
 * Lists all files in the VFS and deletes them.
 * Called after successful render to reclaim memory.
 */
