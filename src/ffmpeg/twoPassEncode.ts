import type { Clip, ExportSettings } from "../types";
import { getClipDuration } from "../utils/project";
import { resolveTargetResolution } from "../utils/resolution";
import { getClipLoopCount } from "../utils/playbackRate";
import { cycleDurationForClip } from "../utils/timeRemap";
import type { PrimaryColorSettings } from "../utils/primaryColor";
import { buildPrimaryColorFfmpegFilters } from "../utils/primaryColor";
import type { NoiseReductionSettings } from "../utils/noiseReduction";
import { buildNoiseReductionFfmpegFilters } from "../utils/noiseReduction";
import type { SecondaryColorSettings } from "../utils/secondaryColor";
import { buildSecondaryColorFfmpegFilters } from "../utils/secondaryColor";
import type { SharpenSettings } from "../utils/sharpen";
import { buildSharpenFfmpegFilters } from "../utils/sharpen";
import type { GrainSettings } from "../utils/grain";
import { buildGrainFfmpegFilters } from "../utils/grain";
import type { IFfmpegRuntime } from "./ffmpegRuntime";
import {
  emitProgress,
  type ProgressCallback,
  type StatusCallback,
} from "./ffmpegCommon";
import { ensureSilentAacUnit, buildSilentAacLoopInputArgs } from "./silentAudio";
import { safeExec, safeWriteFile, isNoVideoStreamError, isNoAudioStreamError } from "./coreRuntime";
import {
  buildClipInputArgs,
  buildSingleClipFilter,
  clipHasSourceAudio,
  clipHasSourceVideo,
  clipNeedsEffects,
  isStillImageClip,
} from "./clipFilters";
import {
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  PASS1_PROGRESS_START,
  PASS1_PROGRESS_END,
} from "./coreConstants";

// Perform two-pass re-encoding for clips with effects
export async function performTwoPassEncode(
  ffmpeg: IFfmpegRuntime,
  clips: Clip[],
  settings: ExportSettings,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): Promise<void> {
  emitProgress(onProgress, "FFmpeg re-encode (two-pass)", 0.12, false);

  // Every clip is normalized to this single resolution so the stitched output
  // never changes size mid-playback when clips have different dimensions.
  const { width: targetWidth, height: targetHeight } = resolveTargetResolution(
    clips,
    settings,
  );

  const intermediates: string[] = [];
  const pass1TotalDuration = clips.reduce(
    (sum, clip) => sum + getClipDuration(clip),
    0,
  );
  let pass1ElapsedDuration = 0;
  for (const [index, clip] of clips.entries()) {
    const clipDuration = getClipDuration(clip);
    const localStart =
      pass1TotalDuration > 0
        ? pass1ElapsedDuration / pass1TotalDuration
        : index / clips.length;
    const localEnd =
      pass1TotalDuration > 0
        ? (pass1ElapsedDuration + clipDuration) / pass1TotalDuration
        : (index + 1) / clips.length;
    const rangeStart =
      PASS1_PROGRESS_START +
      localStart * (PASS1_PROGRESS_END - PASS1_PROGRESS_START);
    const rangeEnd =
      PASS1_PROGRESS_START +
      localEnd * (PASS1_PROGRESS_END - PASS1_PROGRESS_START);
    const outName = await processClipPass1(
      ffmpeg,
      clip,
      index,
      clips.length,
      settings,
      onStatus,
      onProgress,
      rangeStart,
      rangeEnd,
      targetWidth,
      targetHeight,
      primaryColor,
      noiseReduction,
      sharpen,
      secondaryColor,
      grain,
    );
    // Pass 1 encodes exactly ONE cycle. To loop it we repeat that same
    // intermediate filename N times in the pass-2 concat list rather than
    // using `-stream_loop` on the input: buildSingleClipFilter runs the trim
    // through a filter_complex against an already-open `-i`, and
    // `-stream_loop` only affects input demuxing (must precede `-i`), so it
    // can't repeat a filtered/trimmed/setpts'd stream this way. Concat-demuxer
    // repetition also works uniformly for the variable-rate (rate-automation)
    // path, whose one-cycle segments come from the same filter graph.
    const loopCount = getClipLoopCount(clip);
    for (let i = 0; i < loopCount; i++) {
      intermediates.push(outName);
    }
    pass1ElapsedDuration += clipDuration;
  }
  await mergeClipsPass2(
    ffmpeg,
    intermediates,
    onStatus,
    totalDuration,
    onProgress,
  );
}

// Pass 1: produce one intermediate mp4 per clip.
export async function processClipPass1(
  ffmpeg: IFfmpegRuntime,
  clip: Clip,
  index: number,
  total: number,
  settings: ExportSettings,
  onStatus: StatusCallback,
  onProgress: ProgressCallback | undefined,
  rangeStart: number,
  rangeEnd: number,
  targetWidth: number = OUTPUT_WIDTH,
  targetHeight: number = OUTPUT_HEIGHT,
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): Promise<string> {
  const outName = `intermediate-${index}.mp4`;
  // Pass 1 always encodes exactly ONE cycle — the caller (performTwoPassEncode)
  // repeats this intermediate file `loopCount` times in the concat list.
  const clipDuration = cycleDurationForClip(clip);
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;

  // A clip can be stream-copied only when it has no effects AND already matches
  // the target resolution. Otherwise it must be re-encoded (scaled/padded) so
  // every intermediate shares one resolution — concatenating mismatched sizes
  // makes the stitched output change resolution when the clip changes.
  const matchesTargetResolution =
    clip.kind === "video" &&
    clipHasSourceVideo(clip) &&
    clip.videoWidth === targetWidth &&
    clip.videoHeight === targetHeight;

  const primaryFilters = buildPrimaryColorFfmpegFilters(primaryColor);
  const needsPrimary = Boolean(primaryFilters);
  const noiseFilters = buildNoiseReductionFfmpegFilters(noiseReduction);
  const needsNoise = Boolean(noiseFilters);
  const sharpenFilters = buildSharpenFfmpegFilters(sharpen);
  const needsSharpen = Boolean(sharpenFilters);
  const grainFilters = buildGrainFfmpegFilters(grain);
  const needsGrain = Boolean(grainFilters);
  const secondaryFilters = buildSecondaryColorFfmpegFilters(secondaryColor);
  const needsSecondary = Boolean(secondaryFilters);

  const encodeClipPass1 = async (filterComplex: string, label: string) => {
    await safeExec(
      ffmpeg,
      [
        ...buildClipInputArgs(clip),
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
        outName,
      ],
      {
        stage: `Pass 1: ${clip.title}`,
        totalDuration: clipDuration,
        rangeStart,
        rangeEnd,
        onProgress,
      },
      label,
    );
  };

  const encodeClipPass1WithVideoFallback = async (label: string) => {
    if (clip.kind === "video" && !clipHasSourceVideo(clip)) {
      onStatus(
        `Clip "${clip.title}" has no video — synthesizing black video track…`,
      );
      await encodeClipPass1(
        buildSingleClipFilter(
          { ...clip, kind: "audio" },
          targetWidth,
          targetHeight,
          primaryColor,
          noiseReduction,
          sharpen,
          secondaryColor,
          grain,
        ),
        label,
      );
      return;
    }
    try {
      await encodeClipPass1(
        buildSingleClipFilter(
          clip,
          targetWidth,
          targetHeight,
          primaryColor,
          noiseReduction,
          sharpen,
          secondaryColor,
          grain,
        ),
        label,
      );
    } catch (err) {
      if (!isNoVideoStreamError(err)) throw err;
      onStatus(
        `Clip "${clip.title}" has no video — synthesizing black video track…`,
      );
      await encodeClipPass1(
        buildSingleClipFilter(
          { ...clip, kind: "audio" },
          targetWidth,
          targetHeight,
          primaryColor,
          noiseReduction,
          sharpen,
          secondaryColor,
          grain,
        ),
        `${label} (synthesized video)`,
      );
    }
  };

  if (
    !clipNeedsEffects(clip) &&
    !isStillImageClip(clip) &&
    matchesTargetResolution &&
    !needsPrimary &&
    !needsNoise &&
    !needsSharpen &&
    !needsGrain &&
    !needsSecondary
  ) {
    // Fast path: copy video (no decode/encode) + normalize audio to AAC.
    // Audio must be explicitly transcoded so the intermediate has a consistent
    // codec for concat — pure -c copy silently drops audio from non-MP4 sources.
    onStatus(
      `Pass 1 [${index + 1}/${total}]: Copying "${clip.title}" (no effects)...`,
    );
    const args: string[] = [];
    if (clip.trimStart > 0) args.push("-ss", String(clip.trimStart));
    args.push("-i", clip.inputName!);
    if (Number.isFinite(clip.trimEnd)) args.push("-t", String(clipDuration));
    args.push(
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "192k",
      "-avoid_negative_ts",
      "make_zero",
      outName,
    );
    try {
      await safeExec(
        ffmpeg,
        args,
        {
          stage: `Pass 1: ${clip.title}`,
          totalDuration: clipDuration,
          rangeStart,
          rangeEnd,
          onProgress,
        },
        `Pass 1 copy for clip ${index + 1}/${total} "${clip.title}"`,
      );
      return outName;
    } catch (err) {
      if (!isNoVideoStreamError(err)) throw err;
      onStatus(
        `Clip "${clip.title}" has no video — synthesizing black video track…`,
      );
    }
  }

  // Normalize-only path: a clean video clip whose native size differs from the
  // target. Scale/pad to the target resolution (and normalize audio to AAC) so
  // it concatenates seamlessly. Handles clips without an audio stream by
  // synthesizing silence, mirroring the lossless path.
  if (!clipNeedsEffects(clip) && clip.kind === "video") {
    if (!clipHasSourceVideo(clip)) {
      onStatus(
        `Pass 1 [${index + 1}/${total}]: Encoding "${clip.title}" (audio-only source)…`,
      );
      await encodeClipPass1WithVideoFallback(
        `Pass 1 encode for clip ${index + 1}/${total} "${clip.title}" (no video stream)`,
      );
      return outName;
    }

    onStatus(
      `Pass 1 [${index + 1}/${total}]: Normalizing "${clip.title}" to ${targetWidth}x${targetHeight}...`,
    );
    const videoFilter =
      `[0:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS` +
      `,scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease` +
      `,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p` +
      (noiseFilters ? `,${noiseFilters}` : '') +
      (primaryFilters ? `,${primaryFilters}` : '') +
      (sharpenFilters ? `,${sharpenFilters}` : '') +
      (grainFilters ? `,${grainFilters}` : '') +
      `[vout]`;
    const audioFilter =
      `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS` +
      `,aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[aout]`;
    const encodeTail = [
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
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "192k",
      outName,
    ];
    const progressCtx = {
      stage: `Pass 1: ${clip.title}`,
      totalDuration: clipDuration,
      rangeStart,
      rangeEnd,
      onProgress,
    };

    const encodeWithSilentAudio = async () => {
      await ensureSilentAacUnit(ffmpeg, onStatus);
      // Video still re-encodes; audio is stream-copied from the looped silent unit.
      const silentEncodeTail = [
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
        "copy",
        outName,
      ];
      const runSilentMux = async (videoFilterGraph: string, execLabel: string) => {
        await safeExec(
          ffmpeg,
          [
            ...buildClipInputArgs(clip),
            ...buildSilentAacLoopInputArgs(),
            "-filter_complex",
            videoFilterGraph,
            "-map",
            "[vout]",
            "-map",
            "1:a",
            "-t",
            String(clipDuration),
            ...silentEncodeTail,
          ],
          progressCtx,
          execLabel,
        );
      };
      try {
        await runSilentMux(
          videoFilter,
          `Pass 1 normalize for clip ${index + 1}/${total} "${clip.title}" (silent audio)`,
        );
      } catch (err) {
        if (!isNoVideoStreamError(err)) throw err;
        onStatus(
          `Clip "${clip.title}" has no video — synthesizing black video track…`,
        );
        await encodeClipPass1WithVideoFallback(
          `Pass 1 normalize for clip ${index + 1}/${total} "${clip.title}" (no video stream)`,
        );
      }
    };

    if (!clipHasSourceAudio(clip)) {
      onStatus(
        `Clip "${clip.title}" has no audio — muxing silent track (stream copy)…`,
      );
      await encodeWithSilentAudio();
      return outName;
    }

    try {
      await safeExec(
        ffmpeg,
        [
          ...buildClipInputArgs(clip),
          "-filter_complex",
          `${videoFilter};${audioFilter}`,
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          ...encodeTail,
        ],
        progressCtx,
        `Pass 1 normalize for clip ${index + 1}/${total} "${clip.title}"`,
      );
    } catch (err) {
      if (isNoVideoStreamError(err)) {
        onStatus(
          `Clip "${clip.title}" has no video — synthesizing black video track…`,
        );
        await encodeClipPass1WithVideoFallback(
          `Pass 1 normalize for clip ${index + 1}/${total} "${clip.title}" (no video stream)`,
        );
        return outName;
      }
      // Clip has no audio stream — add a silent AAC track so all intermediates
      // share an identical stream layout for concat.
      if (!isNoAudioStreamError(err)) throw err;
      onStatus(
        `Clip "${clip.title}" has no audio — muxing silent track (stream copy)…`,
      );
      await encodeWithSilentAudio();
    }
    return outName;
  }

  // Re-encode path: clip has fades, is audio-only, or is RIFE-processed.
  onStatus(`Pass 1 [${index + 1}/${total}]: Encoding "${clip.title}"...`);
  await encodeClipPass1WithVideoFallback(
    `Pass 1 encode for clip ${index + 1}/${total} "${clip.title}"`,
  );

  return outName;
}

// Pass 2: concatenate all intermediate files produced by Pass 1.
export async function mergeClipsPass2(
  ffmpeg: IFfmpegRuntime,
  intermediateNames: string[],
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
): Promise<void> {
  const concatList = intermediateNames.map((n) => `file '${n}'`).join("\n");
  await safeWriteFile(
    ffmpeg,
    "concat_list.txt",
    concatList,
    "pass2 concat list",
  );

  onStatus("Pass 2: Final concatenation...");
  await safeExec(
    ffmpeg,
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "concat_list.txt",
      "-c",
      "copy",
      "stacked.mp4",
    ],
    {
      stage: "Pass 2: Final concatenation",
      totalDuration,
      rangeStart: 0.85,
      rangeEnd: 0.95,
      onProgress,
    },
    "Pass 2 final concat exec",
  );

  try {
    await ffmpeg.deleteFile("concat_list.txt");
  } catch {
    /* ignore */
  }
  // A looped clip's intermediate filename is repeated in `intermediateNames`
  // (same cycle file concatenated N times) — dedupe so each file is only
  // deleted once.
  for (const name of new Set(intermediateNames)) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }
}
