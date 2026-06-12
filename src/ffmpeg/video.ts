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

export function buildPipFilterComplex(clips: Clip[]): string {
  const parts: string[] = [];

  // ── Phase 1: per-clip pre-processing ────────────────────────────────────────
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const dur = getClipDuration(clip);
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    const isBase = (clip.layerIndex ?? 0) === 0;
    const safeVOut = Math.max(0, dur - clip.videoFadeOut);
    const safeAOut = Math.max(0, dur - clip.audioFadeOut);

    if (clip.kind === "video") {
      let vf = `[${i}:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS`;

      if (isBase) {
        // Normalise to output canvas size
        vf += `,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`;
        vf += `,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
      } else {
        // Scale overlay to requested dimensions (0 means keep original)
        const w = clip.width ?? 0;
        const h = clip.height ?? 0;
        if (w > 0 && h > 0) {
          vf += `,scale=${w}:${h}`;
        } else if (w > 0) {
          vf += `,scale=${w}:-2`;
        } else if (h > 0) {
          vf += `,scale=-2:${h}`;
        }
        // Apply opacity when < 1
        const opacity = clip.opacity ?? 1;
        if (opacity < 1) {
          vf += `,format=rgba,colorchannelmixer=aa=${opacity.toFixed(4)}`;
        }
      }

      if (clip.videoFadeIn > 0) vf += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
      if (clip.videoFadeOut > 0)
        vf += `,fade=t=out:st=${safeVOut}:d=${clip.videoFadeOut}`;
      parts.push(`${vf}[v${i}]`);
    } else {
      // Audio-only: synthesise a black video track
      parts.push(
        `color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:d=${dur},format=yuv420p[v${i}]`,
      );
    }

    // Audio — normalize to 44100 Hz stereo so amix / concat always gets matching streams
    let af = `[${i}:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`;
    if (clip.audioFadeIn > 0) af += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0)
      af += `,afade=t=out:st=${safeAOut}:d=${clip.audioFadeOut}`;
    parts.push(`${af}[a${i}]`);
  }

  // ── Phase 2: concatenate base-layer clips ────────────────────────────────────
  const baseIndices = clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.layerIndex ?? 0) === 0)
    .map(({ i }) => i);

  if (baseIndices.length === 0) {
    throw new Error(
      "PiP compositing requires at least one base-layer clip (layerIndex = 0).",
    );
  }

  let currentV: string;
  let baseAudio: string;

  if (baseIndices.length === 1) {
    currentV = `v${baseIndices[0]}`;
    baseAudio = `a${baseIndices[0]}`;
  } else {
    // concat expects interleaved [v0][a0][v1][a1]...
    const segInputs = baseIndices.map((i) => `[v${i}][a${i}]`).join("");
    parts.push(
      `${segInputs}concat=n=${baseIndices.length}:v=1:a=1[vbase][abase]`,
    );
    currentV = "vbase";
    baseAudio = "abase";
  }

  // ── Phase 3: overlay each PiP clip in layerIndex order ──────────────────────
  const overlayEntries = clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.layerIndex ?? 0) > 0)
    .sort((a, b) => (a.c.layerIndex ?? 0) - (b.c.layerIndex ?? 0));

  const audioStreams: string[] = [baseAudio];

  for (let o = 0; o < overlayEntries.length; o++) {
    const { c: clip, i: idx } = overlayEntries[o];
    const x = clip.x ?? 0;
    const y = clip.y ?? 0;
    const isLast = o === overlayEntries.length - 1;
    const outV = isLast ? "vout" : `vcomp${o}`;

    parts.push(
      `[${currentV}][v${idx}]overlay=${x}:${y}:eof_action=pass[${outV}]`,
    );
    currentV = outV;
    audioStreams.push(`a${idx}`);
  }

  // When there are no overlay clips the base video is already the final output
  if (overlayEntries.length === 0) {
    parts.push(`[${currentV}]null[vout]`);
  }

  // ── Phase 4: mix audio ───────────────────────────────────────────────────────
  if (audioStreams.length === 1) {
    parts.push(`[${audioStreams[0]}]anull[aout]`);
  } else {
    const audioInputs = audioStreams.map((s) => `[${s}]`).join("");
    parts.push(
      `${audioInputs}amix=inputs=${audioStreams.length}:normalize=0[aout]`,
    );
  }

  return parts.join(";");
}

/** Render all clips using a filter_complex that composites PiP/overlay layers. */
export async function mergeClipsWithCompositing(
  ffmpeg: FFmpeg,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  onStatus("Building PiP/compositing render...");
  emitProgress(onProgress, "FFmpeg PiP/compositing render", 0.15, false);

  const filterComplex = buildPipFilterComplex(clips);

  const inputArgs: string[] = [];
  for (const clip of clips) {
    inputArgs.push("-i", clip.inputName!);
  }

  await safeExec(
    ffmpeg,
    [
      ...inputArgs,
      "-filter_complex",
      filterComplex,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-crf",
      String(settings.crf),
      "-preset",
      settings.preset,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "stacked.mp4",
    ],
    {
      stage: "FFmpeg PiP/compositing render",
      totalDuration,
      rangeStart: 0.15,
      rangeEnd: 0.95,
      onProgress,
    },
    "PiP/compositing filter_complex render",
  );
}

/**
 * Minimum size in bytes for a non-empty WAV file (44-byte RIFF header + at
 * least one sample).  An output at or below this threshold means FFmpeg ran
 * without error but produced no audio data — treated as a "no audio stream"
 * failure.
 */
