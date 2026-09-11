import type { Clip } from "../types";
import { getClipDuration } from "../utils/project";
import { audioVolumeFilterSegment, clipHasVolumeAdjustment } from "../utils/audioVolume";
import {
  audioTempoFilterSegment,
  clipHasLoop,
  clipHasPlaybackRateAdjustment,
  getClipPlaybackRate,
  videoSetptsFilter,
} from "../utils/playbackRate";
import { clipHasRateAutomation } from "../utils/timeRemap";
import { buildVariableSpeedFilter } from "../utils/variableSpeed";
import {
  buildPrimaryColorFfmpegFilters,
  type PrimaryColorSettings,
} from "../utils/primaryColor";
import {
  buildNoiseReductionFfmpegFilters,
  type NoiseReductionSettings,
} from "../utils/noiseReduction";
import {
  buildSecondaryColorFfmpegFilters,
  type SecondaryColorSettings,
} from "../utils/secondaryColor";
import {
  buildSharpenFfmpegFilters,
  type SharpenSettings,
} from "../utils/sharpen";
import {
  buildGrainFfmpegFilters,
  type GrainSettings,
} from "../utils/grain";
import { buildSilentAacLoopInputArgs, SILENT_AAC_UNIT_NAME } from "./silentAudio";
import { OUTPUT_WIDTH, OUTPUT_HEIGHT } from "./coreConstants";

export function clipNeedsEffects(clip: Clip): boolean {
  if (clip.kind === "audio") return true;
  if (clip.rifeProcessed) return true;
  return (
    clip.videoFadeIn > 0 ||
    clip.videoFadeOut > 0 ||
    clip.audioFadeIn > 0 ||
    clip.audioFadeOut > 0 ||
    clipHasVolumeAdjustment(clip) ||
    clipHasPlaybackRateAdjustment(clip) ||
    clipHasRateAutomation(clip) ||
    clipHasLoop(clip)
  );
}

/** CFR frame rate for still-image clips materialized as MP4 (NLE-friendly). */
export const STILL_IMAGE_OUTPUT_FPS = 30;

const STILL_IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

/** True when the clip source is a still image (flag or image file extension). */
export function isStillImageClip(
  clip: Pick<Clip, "stillImage" | "file">,
): boolean {
  // Materialized video (e.g. after RIFE) is no longer an image source for FFmpeg.
  if (clip.file.type.startsWith("video/")) return false;
  return clip.stillImage === true || STILL_IMAGE_FILE_RE.test(clip.file.name);
}

/** Still images and image files have no audio stream in FFmpeg. */
export function clipHasSourceAudio(clip: Clip): boolean {
  if (clip.kind === "audio") return true;
  if (isStillImageClip(clip)) return false;
  if (clip.hasAudio === false) return false;
  return true;
}

/**
 * True when the source is expected to carry a decodable video stream.
 * Audio-only `.mp4` files are often tagged `video/mp4` with zero frame size;
 * treat missing/zero dimensions as no video. Stale project metadata may still
 * report width/height — FFmpeg paths retry with synthesized video on `0:v` errors.
 */
export function clipHasSourceVideo(
  clip: Pick<Clip, "kind" | "stillImage" | "file" | "videoWidth" | "videoHeight">,
): boolean {
  if (clip.kind === "audio") return false;
  if (isStillImageClip(clip)) return true;
  if (
    clip.videoWidth != null &&
    clip.videoWidth > 0 &&
    clip.videoHeight != null &&
    clip.videoHeight > 0
  ) {
    return true;
  }
  return false;
}

/** Loop single-frame image inputs so trim/duration filters can reach clip length. */
export function clipNeedsLoopInput(clip: Clip): boolean {
  return isStillImageClip(clip);
}

function evenVideoDimension(value: number): number {
  const n = Math.max(2, Math.floor(value));
  return n % 2 === 0 ? n : n - 1;
}

/** Target encode size for a still image (even dimensions for yuv420p). */
export function resolveStillImageEncodeDimensions(
  clip: Pick<Clip, "videoWidth" | "videoHeight">,
): { width: number; height: number } {
  const width = evenVideoDimension(clip.videoWidth ?? OUTPUT_WIDTH);
  const height = evenVideoDimension(clip.videoHeight ?? OUTPUT_HEIGHT);
  return { width, height };
}

export interface StillImageFilterOptions {
  /**
   * Keep the image's alpha channel: letterbox with transparent padding and
   * finish in `rgba` instead of flattening to `yuv420p`. Required for overlay
   * (layerIndex > 0) layers — a channel bug flattened to `yuv420p` composites
   * as a hard rectangle no matter what the compositor does afterwards.
   */
  preserveAlpha?: boolean;
}

/** Video filter chain for edit-friendly still-image MP4 output. */
export function buildStillImageVideoFilter(
  width: number,
  height: number,
  fps: number = STILL_IMAGE_OUTPUT_FPS,
  options: StillImageFilterOptions = {},
): string {
  const transparent = options.preserveAlpha === true;
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2${transparent ? ":color=0x00000000" : ""}`,
    `fps=${fps}`,
    transparent ? "format=rgba" : "format=yuv420p",
  ].join(",");
}

/** True when a clip sits on an overlay layer and must keep its alpha plane. */
export function clipIsOverlayLayer(clip: Pick<Clip, "layerIndex">): boolean {
  return (clip.layerIndex ?? 0) > 0;
}

export interface StillImageEncodeOptions {
  inputName: string;
  outputName: string;
  durationSec: number;
  width: number;
  height: number;
  /** Pre-encoded silent AAC unit (see `ensureSilentAacUnit`). Defaults to SILENT_AAC_UNIT_NAME. */
  silentUnitName?: string;
}

/**
 * FFmpeg CLI args that turn a still image into an H.264+AAC MP4 hold clip.
 * Uses CFR, regular keyframes, and faststart for broad NLE compatibility.
 * Audio is stream-copied from a looped silent AAC unit (caller must ensure unit is on VFS).
 */
export function buildStillImageFfmpegArgs(
  options: StillImageEncodeOptions,
): string[] {
  const { inputName, outputName, width, height } = options;
  const durationSec = Math.max(0.1, options.durationSec);
  const gop = STILL_IMAGE_OUTPUT_FPS;
  // H.264/MP4 cannot carry alpha, so this materialization path always flattens.
  // Overlay stills stay image inputs in the PiP graph instead (see
  // `buildPipFilterComplex`), which is where `preserveAlpha` applies.
  const vf = buildStillImageVideoFilter(width, height);
  const silentUnit = options.silentUnitName ?? SILENT_AAC_UNIT_NAME;

  return [
    "-loop",
    "1",
    "-t",
    String(durationSec),
    "-i",
    inputName,
    ...buildSilentAacLoopInputArgs(silentUnit),
    "-vf",
    vf,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-tune",
    "stillimage",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-vsync",
    "cfr",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-t",
    String(durationSec),
    outputName,
  ];
}

/** Convenience wrapper using clip native dimensions when available. */
export function buildStillImageFfmpegArgsForClip(
  clip: Pick<Clip, "videoWidth" | "videoHeight">,
  inputName: string,
  outputName: string,
  durationSec: number,
): string[] {
  const { width, height } = resolveStillImageEncodeDimensions(clip);
  return buildStillImageFfmpegArgs({
    inputName,
    outputName,
    durationSec,
    width,
    height,
  });
}

export function buildClipInputArgs(clip: Clip): string[] {
  const input = clip.inputName!;
  if (clipNeedsLoopInput(clip)) return ["-loop", "1", "-i", input];
  return ["-i", input];
}

export function getSafeExtension(
  fileName: string,
  defaultExtension: string,
): string {
  const match = /\.([^.]+)$/.exec(fileName);
  const raw = match?.[1]?.toLowerCase();
  return raw && /^[a-z0-9]+$/.test(raw) ? raw : defaultExtension;
}

export function buildSingleClipFilter(
  clip: Clip,
  targetWidth: number = OUTPUT_WIDTH,
  targetHeight: number = OUTPUT_HEIGHT,
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): string {
  const duration = getClipDuration(clip);
  const end = Number.isFinite(clip.trimEnd) ? clip.trimEnd : clip.duration;
  const safeVideoOut = Math.max(0, duration - clip.videoFadeOut);
  const safeAudioOut = Math.max(0, duration - clip.audioFadeOut);
  const rate = getClipPlaybackRate(clip);
  const setpts = videoSetptsFilter(rate);
  const atempo = audioTempoFilterSegment(rate);
  const parts: string[] = [];
  const useVariableSpeed = clipHasRateAutomation(clip);
  const speedFilter = useVariableSpeed ? buildVariableSpeedFilter(clip) : null;
  if (speedFilter) {
    parts.push(speedFilter.videoFilter, speedFilter.audioFilter);
  }

  if (clip.kind === "video" && clipHasSourceVideo(clip)) {
    const videoInput = speedFilter
      ? speedFilter.videoLabel
      : `[0:v]trim=start=${clip.trimStart}:end=${end},${setpts}`;
    let v = videoInput;
    // Labeled speed-warp outputs (`[vspeed]`) must chain directly into the next
    // filter — a leading comma would insert an empty filter (`No such filter: ''`).
    v += `${speedFilter ? "" : ","}scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`;
    v += `,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    if (clip.videoFadeIn > 0) v += `,fade=t=in:st=0:d=${clip.videoFadeIn}`;
    if (clip.videoFadeOut > 0)
      v += `,fade=t=out:st=${safeVideoOut}:d=${clip.videoFadeOut}`;
    // Finishing: noise → primary → secondary (lut3d) → sharpen → grain (linear).
    const noiseFilters = buildNoiseReductionFfmpegFilters(noiseReduction);
    if (noiseFilters) v += `,${noiseFilters}`;
    const primaryFilters = buildPrimaryColorFfmpegFilters(primaryColor);
    if (primaryFilters) v += `,${primaryFilters}`;
    const secondaryFilters = buildSecondaryColorFfmpegFilters(secondaryColor);
    if (secondaryFilters) v += `,${secondaryFilters}`;
    const sharpenFilters = buildSharpenFfmpegFilters(sharpen);
    if (sharpenFilters) v += `,${sharpenFilters}`;
    // Linear grain only here (noise+vignette); bloom uses labeled pads via appendGrainFilters.
    const grainFilters = buildGrainFfmpegFilters(grain);
    if (grainFilters) v += `,${grainFilters}`;
    parts.push(`${v}[vout]`);

    if (clipHasSourceAudio(clip)) {
      const audioInput = speedFilter
        ? speedFilter.audioLabel
        : `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS${atempo}`;
      let a = speedFilter
        ? `${audioInput}aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`
        : `${audioInput},aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`;
      if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
      if (clip.audioFadeOut > 0)
        a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
      a += audioVolumeFilterSegment(clip.volume ?? 1);
      parts.push(`${a}[aout]`);
    } else {
      parts.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100:d=${duration}[aout]`,
      );
    }
  } else {
    // Synthesize a black video track for audio-only clips at the master canvas size.
    parts.push(
      `color=c=black:s=${targetWidth}x${targetHeight}:d=${duration},format=yuv420p[vout]`,
    );

    const audioInput = speedFilter
      ? speedFilter.audioLabel
      : `[0:a]atrim=start=${clip.trimStart}:end=${end},asetpts=PTS-STARTPTS${atempo}`;
    let a = speedFilter
      ? `${audioInput}aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`
      : `${audioInput},aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo`;
    if (clip.audioFadeIn > 0) a += `,afade=t=in:st=0:d=${clip.audioFadeIn}`;
    if (clip.audioFadeOut > 0)
      a += `,afade=t=out:st=${safeAudioOut}:d=${clip.audioFadeOut}`;
    a += audioVolumeFilterSegment(clip.volume ?? 1);
    parts.push(`${a}[aout]`);
  }

  return parts.join(";");
}
