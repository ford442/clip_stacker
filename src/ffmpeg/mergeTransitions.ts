import type { Clip, ClipTransition, ExportSettings, TextOverlay } from "../types";
import {
  appendPrimaryColorFilters,
  type PrimaryColorSettings,
} from "../utils/primaryColor";
import {
  appendNoiseReductionFilters,
  type NoiseReductionSettings,
} from "../utils/noiseReduction";
import {
  appendSecondaryColorFilters,
  type SecondaryColorSettings,
} from "../utils/secondaryColor";
import {
  appendSharpenFilters,
  type SharpenSettings,
} from "../utils/sharpen";
import {
  appendGrainFilters,
  type GrainSettings,
} from "../utils/grain";
import type { IFfmpegRuntime } from "./ffmpegRuntime";
import {
  emitProgress,
  type ProgressCallback,
  type StatusCallback,
} from "./ffmpegCommon";
import { safeExec, ensureFontsForOverlays, appendTextOverlayFilters } from "./coreRuntime";

/** Render all clips using a single filter_complex with xfade/acrossfade transitions. */
export async function mergeClipsWithTransitions(
  ffmpeg: IFfmpegRuntime,
  clips: Clip[],
  transitions: ClipTransition[],
  settings: ExportSettings,
  filterComplex: string,
  onStatus: StatusCallback,
  totalDuration: number,
  onProgress?: ProgressCallback,
  textOverlays: TextOverlay[] = [],
  primaryColor?: PrimaryColorSettings,
  noiseReduction?: NoiseReductionSettings,
  sharpen?: SharpenSettings,
  secondaryColor?: SecondaryColorSettings,
  grain?: GrainSettings,
): Promise<void> {
  onStatus("Building transition render...");
  emitProgress(onProgress, "FFmpeg transition render", 0.15, false);

  let effectiveFilterComplex = filterComplex;
  // Noise → primary → secondary (lut3d) → sharpen → grain before text overlays.
  effectiveFilterComplex = appendNoiseReductionFilters(effectiveFilterComplex, noiseReduction);
  effectiveFilterComplex = appendPrimaryColorFilters(effectiveFilterComplex, primaryColor);
  effectiveFilterComplex = appendSecondaryColorFilters(effectiveFilterComplex, secondaryColor);
  effectiveFilterComplex = appendSharpenFilters(effectiveFilterComplex, sharpen);
  effectiveFilterComplex = appendGrainFilters(effectiveFilterComplex, grain);
  if (textOverlays.length > 0) {
    await ensureFontsForOverlays(ffmpeg, onStatus, textOverlays);
    effectiveFilterComplex = appendTextOverlayFilters(effectiveFilterComplex, textOverlays);
  }

  const inputArgs: string[] = [];
  for (const clip of clips) {
    inputArgs.push("-i", clip.inputName!);
  }

  await safeExec(
    ffmpeg,
    [
      ...inputArgs,
      "-filter_complex",
      effectiveFilterComplex,
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
      stage: "FFmpeg transition render",
      totalDuration,
      rangeStart: 0.15,
      rangeEnd: 0.95,
      onProgress,
    },
    "Transition filter_complex render",
  );
}
