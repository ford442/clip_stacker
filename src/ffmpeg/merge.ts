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
import { mergeClipsWithCompositing } from "./video";
import { calculateRenderPlan } from "./plan";

export async function mergeClips(
  clips: Clip[],
  transitions: ClipTransition[] = [],
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
  onStatus: StatusCallback,
  textOverlays: TextOverlay[] = [],
  onProgress?: ProgressCallback,
  forceReencode = false,
): Promise<Blob> {
  // Fresh diagnostic buffer for this render so failure messages are relevant.
  clearFfmpegLogs();

  if (clips.length === 0) throw new Error("Upload clips before rendering.");
  const totalDuration = clips.reduce(
    (sum, clip) => sum + getClipDuration(clip),
    0,
  );

  const ffmpeg = await ensureFfmpeg(onStatus, onProgress);
  onStatus("Preparing media...");
  emitProgress(onProgress, "Preparing media", 0.02, false);

  // Clean up leftover files from a previous run.
  for (const entry of await ffmpeg.listDir("/")) {
    if (entry.isDir) continue;
    if (
      entry.name.startsWith("input-") ||
      entry.name.startsWith("intermediate-") ||
      entry.name.startsWith("tol_") ||
      entry.name === "stacked.mp4" ||
      entry.name === "stacked_final.mp4" ||
      entry.name === "concat_list.txt"
    ) {
      try {
        await ffmpeg.deleteFile(entry.name);
      } catch {
        /* ignore */
      }
    }
  }

  // Assign input file names and write to WASM virtual filesystem.
  const workingClips = clips.map((clip, index) => ({
    ...clip,
    inputName: `input-${index}.${getSafeExtension(clip.file.name, clip.kind === "video" ? "mp4" : "mp3")}`,
  }));

  for (const [index, clip] of workingClips.entries()) {
    await safeWriteFile(
      ffmpeg,
      clip.inputName!,
      await fetchFile(clip.file),
      `write input ${index}`,
    );
    const prepProgress = 0.03 + ((index + 1) / workingClips.length) * 0.09;
    emitProgress(onProgress, "Preparing media", prepProgress, false);
  }

  const renderPlan = calculateRenderPlan(
    workingClips,
    transitions,
    textOverlays,
    settings,
  );

  // If force re-encode is enabled and we would otherwise use lossless concat, override to re-encode
  let effectivePlan = renderPlan;
  if (forceReencode && renderPlan.path === "lossless-concat") {
    effectivePlan = {
      path: "effects-reencoding",
      reason: "Force re-encode enabled",
      willReencode: true,
      description: `Forced re-encoding (CRF ${settings.crf}, ${settings.preset} preset)`,
    };
  }

  onStatus(
    `Render plan: ${effectivePlan.description} (${effectivePlan.reason})`,
  );

  const activeTransitions = transitions.filter(
    (t) => t.type !== "none" && t.duration > 0,
  );
  const effectClips = workingClips.filter(clipNeedsEffects);
  const hasPipClips = workingClips.some((c) => (c.layerIndex ?? 0) > 0);
  const transitionFilterComplex =
    activeTransitions.length > 0
      ? buildTransitionFilterComplex(workingClips, activeTransitions)
      : null;

  // If force re-encode is enabled, skip lossless path and go straight to re-encoding
  const shouldForceReencodeNow =
    forceReencode && renderPlan.path === "lossless-concat";

  try {
    if (hasPipClips) {
      // PiP / compositing path — overlay clips on top of the base layer
      onStatus(`FFmpeg path: ${effectivePlan.description}`);
      await mergeClipsWithCompositing(
        ffmpeg,
        workingClips,
        settings,
        onStatus,
        totalDuration,
        onProgress,
        activeTransitions,
      );
    } else if (transitionFilterComplex) {
      // Single-pass filter_complex render covering all clips + transitions
      onStatus(`FFmpeg path: ${effectivePlan.description}`);
      await mergeClipsWithTransitions(
        ffmpeg,
        workingClips,
        activeTransitions,
        settings,
        transitionFilterComplex,
        onStatus,
        totalDuration,
        onProgress,
      );
    } else if (shouldForceReencodeNow) {
      // Force re-encode even though lossless would be used
      onStatus(`FFmpeg path: ${effectivePlan.description}. Starting export...`);
      await performTwoPassEncode(
        ffmpeg,
        workingClips,
        settings,
        onStatus,
        totalDuration,
        onProgress,
      );
    } else if (effectivePlan.path === "lossless-concat") {
      // Lossless path (text overlays will be applied afterward if present)
      onStatus(`FFmpeg path: ${effectivePlan.description}`);
      await mergeClipsLossless(ffmpeg, workingClips, onStatus, onProgress);
    } else {
      // Two-pass re-encoding for effects
      onStatus(`FFmpeg path: ${effectivePlan.description}. Starting export...`);
      await performTwoPassEncode(
        ffmpeg,
        workingClips,
        settings,
        onStatus,
        totalDuration,
        onProgress,
      );
    }
  } finally {
    // Always clean input files even if a render pass threw.
    for (const clip of workingClips) {
      if (clip.inputName) {
        try {
          await ffmpeg.deleteFile(clip.inputName);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Text overlay post-processing ──────────────────────────────────────────
  // Apply drawtext filters on top of the composed stacked.mp4 when overlays exist.
  let finalFileName = "stacked.mp4";

  if (textOverlays.length > 0) {
    await ensureFont(ffmpeg, onStatus);

    // Write each overlay's text to a dedicated temp file to avoid escaping issues.
    for (const overlay of textOverlays) {
      await safeWriteFile(
        ffmpeg,
        `tol_${overlay.id}.txt`,
        overlay.text,
        "text overlay txt",
      );
    }

    const vfFilter = textOverlays.map(buildDrawtextFilter).join(",");
    onStatus("Applying text overlays...");
    emitProgress(onProgress, "Applying text overlays", 0.95, false);

    await safeExec(
      ffmpeg,
      [
        "-i",
        "stacked.mp4",
        "-vf",
        vfFilter,
        "-c:v",
        "libx264",
        "-crf",
        String(settings.crf),
        "-preset",
        settings.preset,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "stacked_final.mp4",
      ],
      {
        stage: "Applying text overlays",
        totalDuration,
        rangeStart: 0.95,
        rangeEnd: 0.99,
        onProgress,
      },
      "Text overlay drawtext pass",
    );

    // Clean up temp text files.
    for (const overlay of textOverlays) {
      try {
        await ffmpeg.deleteFile(`tol_${overlay.id}.txt`);
      } catch {
        /* ignore */
      }
    }

    try {
      await ffmpeg.deleteFile("stacked.mp4");
    } catch {
      /* ignore */
    }
    finalFileName = "stacked_final.mp4";
  }

  const output = await safeReadFile(ffmpeg, finalFileName, "final output read");
  try {
    await ffmpeg.deleteFile(finalFileName);
  } catch {
    /* ignore */
  }
  // Copy to a plain ArrayBuffer so Blob constructor accepts it regardless of
  // whether FFmpeg's backing buffer is a SharedArrayBuffer.
  const plain = new Uint8Array(output).buffer as ArrayBuffer;
  emitProgress(onProgress, "Render finalizing", 1, false);
  return new Blob([plain], { type: "video/mp4" });
}

// ---------------------------------------------------------------------------
// Hybrid pipeline: mux a pre-rendered video blob with clip audio
// ---------------------------------------------------------------------------

/**
 * Mux a pre-rendered video blob (e.g., from MediaRecorder canvas capture) with
 * the audio tracks from the original source clips.
 *
 * This is the final step of the hybrid Canvas/WebGPU rendering pipeline:
 *   Canvas compositing → MediaRecorder capture → muxVideoWithAudio → final MP4
 *
 * Audio from each clip is trimmed, faded (if configured), and concatenated in
 * order before being muxed with the video stream.  The video stream is copied
 * without re-encoding to preserve quality from the capture stage.
 *
 * @param videoBlob  - Video-only blob from the MediaRecorder canvas capture.
 * @param clips      - Original source clips; their audio tracks are extracted and muxed.
 * @param settings   - Export quality settings (used for audio bitrate).
 * @param onStatus   - Status callback for progress messages.
 */
