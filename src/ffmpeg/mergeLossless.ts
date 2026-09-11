import type { Clip } from "../types";
import { getClipDuration } from "../utils/project";
import type { IFfmpegRuntime } from "./ffmpegRuntime";
import {
  emitProgress,
  type ProgressCallback,
  type StatusCallback,
} from "./ffmpegCommon";
import {
  buildSilentAacLoopInputArgs,
  ensureSilentAacUnit,
} from "./silentAudio";
import {
  safeExec,
  safeWriteFile,
  isNoAudioStreamError,
  isNoVideoStreamError,
} from "./coreRuntime";
import {
  buildClipInputArgs,
  buildSingleClipFilter,
  buildStillImageFfmpegArgsForClip,
  clipHasSourceAudio,
  clipHasSourceVideo,
  isStillImageClip,
} from "./clipFilters";

// Fast path: copy video streams (no decode/encode) but normalize audio to AAC.
// We process each clip individually rather than using a single concat-demuxer
// pass because the concat demuxer can silently drop audio when any file in the
// list lacks an audio stream, or when clips have inconsistent audio codecs
// (e.g. Opus in WebM vs AAC in MP4).  Processing per-clip mirrors the two-pass
// encode path and is the only reliable way to guarantee audio in the output.
export async function mergeClipsLossless(
  ffmpeg: IFfmpegRuntime,
  clips: Clip[],
  onStatus: StatusCallback,
  onProgress?: ProgressCallback,
): Promise<void> {
  onStatus("FFmpeg path: fast copy (video copy + audio normalize).");
  emitProgress(onProgress, "FFmpeg fast concat", 0.12, false);

  // Pass 1: per-clip intermediates (video copy + audio → AAC).
  // If a clip has no audio stream we add a silent AAC track so that all
  // intermediates have identical streams, which the concat demuxer requires.
  const intermediates: string[] = [];
  for (const [index, clip] of clips.entries()) {
    const outName = `lossless-${index}.mp4`;
    const clipDuration = getClipDuration(clip);
    const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
    onStatus(`Fast copy [${index + 1}/${clips.length}]: "${clip.title}"...`);

    // Still images cannot be stream-copied: FFmpeg would mux PNG/MJPEG frames into
    // MP4, which breaks concat with H.264 neighbours and fails in most NLEs.
    if (isStillImageClip(clip)) {
      onStatus(`Encoding still image "${clip.title}" to H.264…`);
      await ensureSilentAacUnit(ffmpeg, onStatus);
      await safeExec(
        ffmpeg,
        buildStillImageFfmpegArgsForClip(
          clip,
          clip.inputName!,
          outName,
          clipDuration,
        ),
        null,
        `Lossless still encode ${index + 1}/${clips.length} "${clip.title}"`,
      );
      intermediates.push(outName);
      continue;
    }

    const encodeLosslessNoVideo = async () => {
      onStatus(
        `Clip "${clip.title}" has no video — synthesizing black video track…`,
      );
      await safeExec(
        ffmpeg,
        [
          ...buildClipInputArgs(clip),
          "-filter_complex",
          buildSingleClipFilter({ ...clip, kind: "audio" }),
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          "-c:v",
          "libx264",
          "-crf",
          "16",
          "-preset",
          "veryfast",
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
        ],
        null,
        `Lossless encode clip ${index + 1}/${clips.length} "${clip.title}" (no video)`,
      );
    };

    if (!clipHasSourceVideo(clip) && clip.kind === "video") {
      await encodeLosslessNoVideo();
      intermediates.push(outName);
      emitProgress(
        onProgress,
        "FFmpeg fast concat",
        0.12 + (0.73 * (index + 1)) / clips.length,
        false,
      );
      continue;
    }

    let primaryArgs: string[];
    let silentAudioArgs: string[];
    const silentDurationArgs: string[] = [
      "-t",
      String(Math.max(0.01, clipDuration)),
    ];

    if (clip.trimStart > 0) {
      // `-ss` before `-i` combined with `-c:v copy` can't cut mid-GOP: ffmpeg
      // rounds the seek down to the keyframe at/before trimStart and re-includes
      // everything from that keyframe up to trimStart in the output, while
      // -avoid_negative_ts make_zero collapses that leading span to PTS=0. The
      // re-encoded audio track *does* seek accurately to trimStart, so the
      // result is a silent video-only lead-in showing the footage the user
      // trimmed away — a frozen/paused start to the render. Re-encode the
      // video via trim+setpts for clips with a non-zero trim-in so both
      // streams start exactly at trimStart.
      const videoFilter = `[0:v]trim=start=${clip.trimStart}:end=${end},setpts=PTS-STARTPTS[vout]`;
      const audioFilter = `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[aout]`;
      const videoEncodeTail: string[] = [
        "-c:v",
        "libx264",
        "-crf",
        "16",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
      ];
      const aacEncodeTail: string[] = [
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
      primaryArgs = [
        ...buildClipInputArgs(clip),
        "-filter_complex",
        `${videoFilter};${audioFilter}`,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        ...videoEncodeTail,
        ...aacEncodeTail,
      ];
      // Stream-copy pre-encoded silent AAC (loop unit) instead of encoding anullsrc.
      silentAudioArgs = [
        ...buildClipInputArgs(clip),
        ...buildSilentAacLoopInputArgs(),
        "-filter_complex",
        videoFilter,
        "-map",
        "[vout]",
        "-map",
        "1:a",
        ...silentDurationArgs,
        ...videoEncodeTail,
        "-c:a",
        "copy",
        outName,
      ];
    } else {
      const durationArgs: string[] = Number.isFinite(clip.trimEnd)
        ? ["-t", String(clipDuration)]
        : [];
      primaryArgs = [
        ...buildClipInputArgs(clip),
        ...durationArgs,
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
      ];
      silentAudioArgs = [
        ...buildClipInputArgs(clip),
        ...buildSilentAacLoopInputArgs(),
        "-map",
        "0:v",
        "-map",
        "1:a",
        ...silentDurationArgs,
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        outName,
      ];
    }

    if (!clipHasSourceAudio(clip)) {
      onStatus(
        `Clip "${clip.title}" has no audio — muxing silent track (stream copy)…`,
      );
      await ensureSilentAacUnit(ffmpeg, onStatus);
      await safeExec(
        ffmpeg,
        silentAudioArgs,
        null,
        `Lossless copy clip ${index + 1}/${clips.length} "${clip.title}" (silent audio)`,
      );
    } else {
      try {
        await safeExec(
          ffmpeg,
          primaryArgs,
          null,
          `Lossless copy clip ${index + 1}/${clips.length} "${clip.title}"`,
        );
      } catch (err) {
        if (isNoVideoStreamError(err)) {
          await encodeLosslessNoVideo();
        } else if (isNoAudioStreamError(err)) {
          // Retry without source audio if the clip has no audio stream.  Loop a
          // pre-encoded silent AAC unit so the intermediate still carries a silent
          // track for concat layout consistency — without re-encoding silence.
          onStatus(
            `Clip "${clip.title}" has no audio — muxing silent track (stream copy)…`,
          );
          await ensureSilentAacUnit(ffmpeg, onStatus);
          await safeExec(
            ffmpeg,
            silentAudioArgs,
            null,
            `Lossless copy clip ${index + 1}/${clips.length} "${clip.title}" (silent audio)`,
          );
        } else {
          throw err;
        }
      }
    }

    intermediates.push(outName);
    emitProgress(
      onProgress,
      "FFmpeg fast concat",
      0.12 + (0.73 * (index + 1)) / clips.length,
      false,
    );
  }

  // Pass 2: stream-copy all intermediates (identical codec → no re-encode).
  const concatList = intermediates.map((n) => `file '${n}'`).join("\n");
  await safeWriteFile(
    ffmpeg,
    "concat_list.txt",
    concatList,
    "lossless concat list",
  );
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
    null,
    "Lossless concat pass 2",
  );
  emitProgress(onProgress, "FFmpeg fast concat", 0.9, false);

  try {
    await ffmpeg.deleteFile("concat_list.txt");
  } catch {
    /* ignore */
  }
  for (const name of intermediates) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }
}
