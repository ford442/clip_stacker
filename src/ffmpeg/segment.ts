import { fetchFile } from "@ffmpeg/util";
import {
  clearFfmpegLogs,
  ensureFfmpeg,
  getSafeExtension,
  safeExec,
  safeReadFile,
  safeWriteFile,
  type StatusCallback,
} from "./core";

/**
 * `copy` = `-c copy` (instant, keeps the original streams, but a cut that does
 * not start on a keyframe pulls in the frames before it); `reencode` = exact.
 */
export type SegmentCutMode = "copy" | "reencode";

export function buildSegmentCutArgs(
  input: string,
  output: string,
  startSec: number,
  endSec: number,
  mode: SegmentCutMode,
  audioOnly: boolean,
): string[] {
  const args = ["-ss", String(startSec), "-i", input, "-t", String(endSec - startSec)];
  if (mode === "copy" || audioOnly) {
    return [...args, "-c", "copy", "-avoid_negative_ts", "make_zero", output];
  }
  return [
    ...args,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    output,
  ];
}

/**
 * Cut `[startSec, endSec]` out of `file` with FFmpeg.wasm. The whole input is
 * written into the wasm filesystem, so callers keep this for small files and
 * hand big ones to the Contabo worker (`extractSegment.ts` decides).
 */
export async function cutSegmentWithFfmpeg(
  file: File,
  startSec: number,
  endSec: number,
  mode: SegmentCutMode,
  onStatus: StatusCallback,
): Promise<Blob> {
  clearFfmpegLogs();
  const ffmpeg = await ensureFfmpeg(onStatus);

  const audioOnly = file.type.startsWith("audio/") || /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.name);
  const inputExt = getSafeExtension(file.name, audioOnly ? "wav" : "mp4");
  const inputName = `segment-input.${inputExt}`;
  const outputName = `segment-output.${audioOnly ? inputExt : "mp4"}`;

  for (const name of [inputName, outputName]) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      /* ignore */
    }
  }

  onStatus(`${mode === "copy" ? "Copying" : "Re-encoding"} ${startSec.toFixed(2)}–${endSec.toFixed(2)}s of "${file.name}"…`);
  try {
    await safeWriteFile(ffmpeg, inputName, await fetchFile(file), "segment write input");
    await safeExec(
      ffmpeg,
      buildSegmentCutArgs(inputName, outputName, startSec, endSec, mode, audioOnly),
      null,
      `Segment ${mode} of "${file.name}" (${startSec}-${endSec})`,
    );
    const output = await safeReadFile(ffmpeg, outputName, "segment read output");
    const plain = new Uint8Array(output).buffer as ArrayBuffer;
    return new Blob([plain], { type: audioOnly ? file.type || "audio/wav" : "video/mp4" });
  } finally {
    for (const name of [inputName, outputName]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }
    }
  }
}
