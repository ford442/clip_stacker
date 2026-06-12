import { NO_AUDIO_STREAM_RE } from "./core";
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

export const WAV_HEADER_MIN_BYTES = 45;

/**
 * Pre-flight validation for extractAudioToWav.
 * Returns null on success, or an error message string if validation fails.
 * Exported for unit testing.
 */
export function validateExtractAudioClip(clip: Clip): string | null {
  const rawDur =
    (Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration) -
    clip.trimStart;
  if (rawDur <= 0) {
    return (
      `Cannot extract audio: clip "${clip.title}" has zero or negative duration after trim ` +
      `(trimStart=${clip.trimStart}, trimEnd=${Number.isFinite(clip.trimEnd) ? clip.trimEnd : "end"}, ` +
      `duration=${clip.duration}).`
    );
  }
  return null;
}

export async function extractAudioToWav(
  clip: Clip,
  onStatus: StatusCallback,
): Promise<Blob> {
  // Pre-flight: fast early validation before loading FFmpeg.
  const preflightError = validateExtractAudioClip(clip);
  if (preflightError) throw new Error(preflightError);

  // Start fresh log capture for this operation so any failure has clean context.
  clearFfmpegLogs();

  const ffmpeg = await ensureFfmpeg(onStatus);

  // For audio-only source files use the actual file extension so FFmpeg can
  // correctly demux (e.g. mp3, aac, ogg).  Fall back to mp4 for video clips.
  const defaultExt = clip.kind === "audio" ? "mp3" : "mp4";
  const ext = getSafeExtension(clip.file.name, defaultExt);
  const inputName = `audio-extract-input.${ext}`;
  const outputName = "audio-extract-output.wav";

  // Clean up any leftover files from a previous extraction run.
  for (const name of [inputName, outputName]) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }

  onStatus(`Writing "${clip.title}" to FFmpeg…`);

  try {
    await safeWriteFile(
      ffmpeg,
      inputName,
      await fetchFile(clip.file),
      "extract write input",
    );

    const args: string[] = [];

    // Seek before input for fast container-level seek when trimStart is set.
    if (clip.trimStart > 0) args.push("-ss", String(clip.trimStart));
    args.push("-i", inputName);
    if (Number.isFinite(clip.trimEnd)) {
      args.push("-t", String(clip.trimEnd - clip.trimStart));
    }

    args.push(
      "-map",
      "0:a:0", // explicitly select the first audio stream — gives a clear
      // "matches no streams" error if the file has no audio
      "-vn", // drop video stream (no-op for audio-only files; safe to include)
      "-acodec",
      "pcm_s16le", // PCM 16-bit little-endian (WAV)
      "-ar",
      "44100", // 44.1 kHz sample rate
      "-ac",
      "2", // stereo
      outputName,
    );

    onStatus(`Extracting audio from "${clip.title}"…`);

    try {
      await safeExec(
        ffmpeg,
        args,
        null,
        `Extract audio exec for "${clip.title}" (trim ${clip.trimStart}-${clip.trimEnd || "end"})`,
      );
    } catch (execErr) {
      // Intercept "no audio stream" errors and surface a clear user message.
      const msg = (execErr as Error).message;
      if (NO_AUDIO_STREAM_RE.test(msg)) {
        throw new Error(
          `No audio stream found in "${clip.title}". ` +
            `The file may be video-only or use an unsupported audio codec.\n\n${msg}`,
        );
      }
      throw execErr;
    }

    const output = await safeReadFile(
      ffmpeg,
      outputName,
      "extract read output",
    );

    // A valid WAV file with audio data must be larger than the RIFF header.
    // An empty or header-only output means FFmpeg ran without error but wrote
    // no audio samples — treat this as a silent failure.
    if (output.byteLength <= WAV_HEADER_MIN_BYTES) {
      throw new Error(
        `Audio extraction produced an empty output for "${clip.title}". ` +
          `The clip may contain no audio stream, or the trimmed region contains no audio data.`,
      );
    }

    // Copy to a plain ArrayBuffer so Blob constructor accepts it regardless of
    // whether FFmpeg's backing buffer is a SharedArrayBuffer.
    const plain = new Uint8Array(output).buffer as ArrayBuffer;

    onStatus("Audio extraction complete.");
    return new Blob([plain], { type: "audio/wav" });
  } catch (err) {
    // Always attempt cleanup on failure path.
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
    // Re-throw the (already detailed) error
    throw err;
  } finally {
    // Best-effort final cleanup even on success path.
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
 * Export a trimmed video segment to an MP4 blob using lossless stream copy.
 * Used by the RIFE integration to send the exact trimmed region to the
 * HuggingFace frame-interpolation space (per-clip, before merge).
 */
