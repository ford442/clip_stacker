/**
 * Caption export: burn-in, soft `mov_text` mux, and sidecar `.srt`.
 *
 * These run as a **post-pass over the finished MP4** rather than being folded
 * into the render's own filter graph. That is deliberate: `hybridMergeClips`
 * can finish on any of three encoders (WebCodecs GPU, the Canvas2D renderer,
 * or FFmpeg), and only one of them has a filter graph to hook. A post-pass
 * gives every path identical captions for the cost of one extra pass — a
 * stream copy for soft subtitles, and a video re-encode for burn-in.
 *
 * Burn-in uses libass via FFmpeg's `ass` filter (the bundled `@ffmpeg/core`
 * is built `--enable-libass`) and a generated `.ass` document, because
 * `drawtext` cannot vary text over time and `.srt` alone carries no styling.
 */

import type { CaptionEntry, TextOverlayStyle } from '../types';
import {
  buildAssDocument,
  resolveCaptionStyle,
  serializeSrt,
} from '../utils/subtitles';
import { getBundledFont } from '../utils/textOverlay';
import {
  ensureFfmpeg,
  ensureFont,
  safeExec,
  safeReadFile,
  safeWriteFile,
  type ProgressCallback,
  type StatusCallback,
} from './core';

/** How captions are attached to the exported MP4. */
export type CaptionExportMode = 'none' | 'burn' | 'soft';

export const CAPTION_EXPORT_MODE_LABELS: Record<CaptionExportMode, string> = {
  none: 'Off (timeline only)',
  burn: 'Burn into video',
  soft: 'Soft subtitle track',
};

/** VFS filenames used by the caption passes. Fixed, so filter args need no escaping. */
export const CAPTION_ASS_NAME = 'captions.ass';
export const CAPTION_SRT_NAME = 'captions.srt';
const CAPTION_INPUT_NAME = 'caption_in.mp4';
const CAPTION_OUTPUT_NAME = 'caption_out.mp4';

export interface BurnCaptionsArgsOptions {
  inputName: string;
  outputName: string;
  /** Generated `.ass` document already written to the VFS. */
  subtitleName: string;
  /** libx264 CRF for the re-encode. */
  crf: number;
  preset: string;
}

/**
 * Build the burn-in command.
 *
 * `fontsdir=.` points libass at the working directory, where `ensureFont` has
 * written the bundled TTFs — this core has no fontconfig, so the directory
 * scan is the only way it can resolve a family name. Audio is stream-copied;
 * only video is touched.
 */
export function buildBurnCaptionsArgs({
  inputName,
  outputName,
  subtitleName,
  crf,
  preset,
}: BurnCaptionsArgsOptions): string[] {
  return [
    '-i', inputName,
    '-vf', `ass=${subtitleName}:fontsdir=.`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y', outputName,
  ];
}

export interface SoftSubtitleArgsOptions {
  inputName: string;
  outputName: string;
  /** `.srt` sidecar already written to the VFS. */
  subtitleName: string;
  /** ISO 639-2 language tag written into the subtitle track's metadata. */
  language?: string;
}

/**
 * Build the soft-subtitle mux command: remux the existing streams untouched
 * and add the `.srt` as an MP4 `mov_text` track, which players (VLC,
 * QuickTime, Chrome) expose as a toggle-able subtitle track.
 */
export function buildSoftSubtitleArgs({
  inputName,
  outputName,
  subtitleName,
  language = 'eng',
}: SoftSubtitleArgsOptions): string[] {
  return [
    '-i', inputName,
    '-i', subtitleName,
    '-map', '0',
    '-map', '1',
    '-c', 'copy',
    '-c:s', 'mov_text',
    `-metadata:s:s:0`, `language=${language}`,
    '-movflags', '+faststart',
    '-y', outputName,
  ];
}

/** Serialize captions to a downloadable `.srt` file. No re-encode involved. */
export function captionsToSrtBlob(captions: CaptionEntry[]): Blob {
  return new Blob([serializeSrt(captions)], {
    type: 'application/x-subrip;charset=utf-8',
  });
}

/**
 * Ensure every bundled font referenced by the captions is in the VFS so
 * libass can find it by family name during the burn.
 */
async function ensureCaptionFonts(
  ffmpeg: Parameters<typeof safeWriteFile>[0],
  onStatus: StatusCallback,
  captions: CaptionEntry[],
  projectStyle: Partial<TextOverlayStyle> | undefined,
): Promise<void> {
  const needed = new Set<string>();
  needed.add(getBundledFont(resolveCaptionStyle(undefined, projectStyle).font).virtualName);
  for (const caption of captions) {
    needed.add(
      getBundledFont(resolveCaptionStyle(caption, projectStyle).font).virtualName,
    );
  }
  for (const virtualName of needed) {
    await ensureFont(ffmpeg, onStatus, virtualName);
  }
}

export interface ApplyCaptionsOptions {
  mode: CaptionExportMode;
  /** Output size, used for `PlayRes` so `\pos()` lands on the right pixels. */
  width: number;
  height: number;
  /** Project-wide caption style; per-cue `style` overrides win over it. */
  projectStyle?: Partial<TextOverlayStyle>;
  /** libx264 settings reused from the export settings for the burn re-encode. */
  crf?: number;
  preset?: string;
  language?: string;
  onStatus?: StatusCallback;
  onProgress?: ProgressCallback;
  /** Output duration in seconds, for FFmpeg log-derived progress. */
  totalDuration?: number;
}

/**
 * Attach `captions` to an already-rendered MP4 and return the new blob.
 *
 * Returns the input blob unchanged when there is nothing to do (`mode: 'none'`
 * or no cues), so callers can invoke it unconditionally.
 */
export async function applyCaptionsToRenderedVideo(
  videoBlob: Blob,
  captions: CaptionEntry[],
  options: ApplyCaptionsOptions,
): Promise<Blob> {
  const {
    mode,
    width,
    height,
    projectStyle,
    crf = 18,
    preset = 'medium',
    language = 'eng',
    onStatus = () => {},
    onProgress,
    totalDuration = 0,
  } = options;

  if (mode === 'none' || captions.length === 0) return videoBlob;

  const ffmpeg = await ensureFfmpeg(onStatus, onProgress);
  const subtitleName = mode === 'burn' ? CAPTION_ASS_NAME : CAPTION_SRT_NAME;
  const stage = mode === 'burn' ? 'Burning in captions' : 'Adding subtitle track';

  onStatus(
    mode === 'burn'
      ? `Burning ${captions.length} caption${captions.length === 1 ? '' : 's'} into the video…`
      : `Muxing ${captions.length} caption${captions.length === 1 ? '' : 's'} as a soft subtitle track…`,
  );

  try {
    await safeWriteFile(
      ffmpeg,
      CAPTION_INPUT_NAME,
      new Uint8Array(await videoBlob.arrayBuffer()),
      'caption pass input write',
    );
    await safeWriteFile(
      ffmpeg,
      subtitleName,
      mode === 'burn'
        ? buildAssDocument(captions, { width, height, projectStyle })
        : serializeSrt(captions),
      'caption file write',
    );

    if (mode === 'burn') {
      await ensureCaptionFonts(ffmpeg, onStatus, captions, projectStyle);
    }

    const args =
      mode === 'burn'
        ? buildBurnCaptionsArgs({
            inputName: CAPTION_INPUT_NAME,
            outputName: CAPTION_OUTPUT_NAME,
            subtitleName,
            crf,
            preset,
          })
        : buildSoftSubtitleArgs({
            inputName: CAPTION_INPUT_NAME,
            outputName: CAPTION_OUTPUT_NAME,
            subtitleName,
            language,
          });

    await safeExec(
      ffmpeg,
      args,
      onProgress && totalDuration > 0
        ? { stage, totalDuration, rangeStart: 0, rangeEnd: 1, onProgress }
        : null,
      mode === 'burn' ? 'Caption burn-in' : 'Soft subtitle mux',
    );

    const data = await safeReadFile(ffmpeg, CAPTION_OUTPUT_NAME, 'caption pass read');
    // Copy out of the (possibly shared) WASM heap before handing it to Blob.
    const bytes = new Uint8Array(data).buffer as ArrayBuffer;
    return new Blob([bytes], { type: 'video/mp4' });
  } finally {
    // Best-effort cleanup; the caller's VFS sweep catches anything left over.
    for (const name of [CAPTION_INPUT_NAME, CAPTION_OUTPUT_NAME, subtitleName]) {
      await ffmpeg.deleteFile(name).catch(() => {});
    }
  }
}
