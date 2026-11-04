/**
 * Utilities for integrating with the HuggingFace Space `1inkusFace/RIFE`
 * to perform per-clip frame interpolation (RIFE) and Boomerang effects.
 *
 * Architecture note: RIFE is applied per-clip, AFTER trimming but BEFORE
 * merging. Running it on the final merged video would cause ugly morphing
 * artifacts across scene cuts.
 */

import {
  callSpaceEndpoint,
  downloadSpaceFile,
  extractGradioOutputValue,
  uploadFilesToSpace,
} from "./gradioSpace";

export type RifeMode = "interpolation" | "boomerang";
export type RifeOutputFormat = "mp4" | "prores";

export interface RifeProgressEvent {
  stage: "uploading" | "processing" | "downloading";
  /** 0–100 progress percentage, or null if indeterminate */
  progress: number | null;
  message?: string;
}

export interface RifeResult {
  blob: Blob;
}

/** Progress event from a multi-clip run, tagged with which clip it is about. */
export interface RifeBatchProgressEvent extends RifeProgressEvent {
  /** 0-based index of the clip this event concerns. */
  clipIndex: number;
  /** Total clips in the batch. */
  clipCount: number;
}

export interface MorphTransitionResult {
  blob: Blob;
  duration: number;
  frameCount: number;
}

const MORPH_OUTPUT_FPS = 30;
/**
 * Output frame rate requested from the Space's interpolate_video endpoint.
 * 24fps sources at the 4x multiplier generate 96 interpolated frames; 60
 * keeps a true 60fps CFR result instead of the endpoint's own default (30,
 * kept for older callers), which would drop most of those frames.
 */
const RIFE_OUTPUT_FPS = "60";

/**
 * Send a trimmed video Blob to the HuggingFace RIFE space and return
 * the processed video as a Blob.
 *
 * @param videoBlob  - The trimmed source video clip.
 * @param multiplier - Frame-rate multiplier (2 = 2×, 4 = 4×). Default 2.
 * @param mode       - 'interpolation' (smooth motion) or 'boomerang' (loop).
 * @param onProgress - Optional progress callback.
 */
export async function processClipWithRIFE(
  videoBlob: Blob,
  multiplier: 2 | 4 = 2,
  mode: RifeMode = "interpolation",
  onProgress?: (event: RifeProgressEvent) => void,
  outputFormat: RifeOutputFormat = "mp4",
): Promise<RifeResult> {
  onProgress?.({
    stage: "uploading",
    progress: 0,
    message: "Connecting to RIFE space…",
  });

  onProgress?.({
    stage: "uploading",
    progress: 20,
    message: "Uploading clip to RIFE…",
  });
  const path = await uploadClipForRife(videoBlob);
  return interpolateUploadedClip(path, multiplier, mode, onProgress, outputFormat);
}

/**
 * Interpolate several clips, overlapping each upload with the processing of
 * the clip before it.
 *
 * The Space serializes GPU work anyway, so processing stays sequential — but
 * uploading clip N+1 while clip N is on the GPU removes the upload from the
 * critical path for every clip after the first. Results come back in input
 * order.
 *
 * `processClipWithRIFE` remains the entry point for the single-clip case;
 * with one blob this behaves identically.
 *
 * @param videoBlobs - Trimmed source clips, in output order.
 * @param multiplier - Frame-rate multiplier (2 = 2×, 4 = 4×). Default 2.
 * @param mode       - 'interpolation' (smooth motion) or 'boomerang' (loop).
 * @param onProgress - Optional progress callback, tagged with the clip index.
 */
export async function processClipsWithRIFE(
  videoBlobs: Blob[],
  multiplier: 2 | 4 = 2,
  mode: RifeMode = "interpolation",
  onProgress?: (event: RifeBatchProgressEvent) => void,
  outputFormat: RifeOutputFormat = "mp4",
): Promise<RifeResult[]> {
  if (videoBlobs.length === 0) return [];

  const clipCount = videoBlobs.length;

  // Kick every upload off up front, chained so they do not all contend for
  // bandwidth at once but each one still starts before its turn on the GPU.
  let uploadChain: Promise<unknown> = Promise.resolve();
  const uploads = videoBlobs.map((blob) => {
    const upload = uploadChain.then(() => uploadClipForRife(blob));
    // Keep the chain going past a failure, and make sure a rejection that is
    // not awaited until later does not surface as an unhandled rejection.
    uploadChain = upload.catch(() => undefined);
    return upload;
  });

  const results: RifeResult[] = [];
  try {
    for (let i = 0; i < clipCount; i++) {
      const forClip = onProgress
        ? (event: RifeProgressEvent) =>
            onProgress({ ...event, clipIndex: i, clipCount })
        : undefined;
      const path = await uploads[i];
      results.push(
        await interpolateUploadedClip(path, multiplier, mode, forClip, outputFormat),
      );
    }
  } finally {
    // Drain the remaining uploads so an early failure does not leave pending
    // rejections behind.
    await Promise.allSettled(uploads);
  }

  return results;
}

/** Upload one clip and return the server-side path Gradio assigned it. */
async function uploadClipForRife(videoBlob: Blob): Promise<string> {
  try {
    // Uses the raw Gradio HTTP API with credentials:"omit" rather than
    // @gradio/client — see the note on stitchClipsOnGpu for why the bundled
    // client cannot reach a public HF Space from a deployed browser origin.
    const [path] = await uploadFilesToSpace([videoBlob]);
    return path;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`RIFE processing failed: ${message}`, { cause: err });
  }
}

/** Run interpolate_video on an already-uploaded clip and fetch the result. */
async function interpolateUploadedClip(
  path: string,
  multiplier: 2 | 4,
  mode: RifeMode,
  onProgress?: (event: RifeProgressEvent) => void,
  outputFormat: RifeOutputFormat = "mp4",
): Promise<RifeResult> {
  const isBoomerang = mode === "boomerang";

  let output: unknown;
  try {
    onProgress?.({
      stage: "processing",
      progress: null,
      message: "Processing with RIFE…",
    });

    // The space's interpolate_video endpoint accepts:
    //   [video (VideoData), multiplier ("2"/"4"/"8"), boomerang (bool),
    //    output fps ("30"/"60"/"native"), output format ("mp4"/"prores")]
    // Its input is a gr.Video, whose data model is VideoData
    // `{ video: FileData, subtitles }` — not a bare FileData like the gr.File
    // inputs of /stitch and /morph. Gradio validates that shape before the
    // function runs, so a bare FileData fails with "VideoData video Field
    // required" on every clip.
    const data = await callSpaceEndpoint("interpolate_video", [
      { video: { path, meta: { _type: "gradio.FileData" } }, subtitles: null },
      String(multiplier),
      isBoomerang,
      RIFE_OUTPUT_FPS,
      outputFormat,
    ]);
    output = extractGradioOutputValue(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`RIFE processing failed: ${message}`, { cause: err });
  }

  onProgress?.({
    stage: "downloading",
    progress: 80,
    message: "Downloading processed clip…",
  });

  if (output == null) {
    throw new Error("RIFE returned no output.");
  }
  const outputBlob = await downloadSpaceFile(output, "RIFE output");

  onProgress?.({ stage: "downloading", progress: 100, message: "Done." });

  return { blob: outputBlob };
}

/**
 * Generate a RIFE morph segment from a 2-frame clip (A_last, B_first).
 *
 * @param framePairBlob - Two-frame MP4 from extractMorphFramePair.
 * @param frameCount    - Number of output frames (duration × fps).
 * @param onProgress    - Optional progress callback (upload / processing / download).
 */
export async function generateMorphTransition(
  framePairBlob: Blob,
  frameCount: number,
  onProgress?: (event: RifeProgressEvent) => void,
): Promise<MorphTransitionResult> {
  const safeFrameCount = Math.max(2, Math.round(frameCount));

  onProgress?.({
    stage: 'uploading',
    progress: 0,
    message: 'Connecting to RIFE morph space…',
  });

  let output: unknown;
  try {
    onProgress?.({
      stage: 'uploading',
      progress: 20,
      message: 'Uploading morph frame pair…',
    });
    const [path] = await uploadFilesToSpace([framePairBlob]);

    onProgress?.({
      stage: 'processing',
      progress: null,
      message: `Generating ${safeFrameCount} morph frames with RIFE…`,
    });

    const data = await callSpaceEndpoint('morph', [
      { path, meta: { _type: 'gradio.FileData' } },
      safeFrameCount,
      MORPH_OUTPUT_FPS,
    ]);
    output = extractGradioOutputValue(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Morph transition failed: ${message}`, { cause: err });
  }

  onProgress?.({
    stage: 'downloading',
    progress: 80,
    message: 'Downloading morph segment…',
  });

  if (output == null) {
    throw new Error(
      'Morph transition failed: the space returned no output (it may be cold or timed out).',
    );
  }

  const outputBlob = await downloadSpaceFile(output, 'morph segment');
  const duration = safeFrameCount / MORPH_OUTPUT_FPS;

  onProgress?.({ stage: 'downloading', progress: 100, message: 'Morph segment ready.' });

  return { blob: outputBlob, duration, frameCount: safeFrameCount };
}

export interface GpuStitchResult {
  blob: Blob;
}

/**
 * Stitch multiple (already-trimmed) video clips into one MP4 on the HuggingFace
 * space's GPU. The space normalizes every clip to `resolution` (scale + pad)
 * before concatenating, so the result keeps a single resolution even when the
 * source clips have different native sizes.
 *
 * Note: this path concatenates clips at the target resolution only — it does
 * NOT apply fades, transitions, PiP, text overlays, or per-clip volume. Those
 * remain the responsibility of the in-browser FFmpeg render path.
 *
 * @param clipBlobs  - Trimmed clips (video or still-image segments), in timeline order.
 * @param resolution - Target resolution as "WIDTHxHEIGHT" (e.g. "1920x1080").
 * @param onProgress - Optional progress callback.
 */
export async function stitchClipsOnGpu(
  clipBlobs: Blob[],
  resolution: string,
  onProgress?: (event: RifeProgressEvent) => void,
): Promise<GpuStitchResult> {
  if (clipBlobs.length === 0) {
    throw new Error("No clips to stitch.");
  }

  onProgress?.({
    stage: "uploading",
    progress: 0,
    message: "Connecting to stitch space…",
  });

  let output: unknown;
  try {
    // NOTE: we deliberately do NOT use @gradio/client here. That client hard-
    // codes `credentials: "include"` on every request, and HuggingFace serves
    // public Spaces with `Access-Control-Allow-Origin: *`. Browsers forbid
    // credentialed requests against a wildcard origin, so Client.connect() fails
    // CORS preflight from any deployed origin. Talking to the Gradio HTTP API
    // directly with `credentials: "omit"` is compatible with the wildcard CORS.

    onProgress?.({
      stage: "uploading",
      progress: 20,
      message: `Uploading ${clipBlobs.length} clip${clipBlobs.length > 1 ? "s" : ""} to GPU…`,
    });
    const uploadedPaths = await uploadFilesToSpace(clipBlobs);

    onProgress?.({
      stage: "processing",
      progress: null,
      message: `Stitching ${clipBlobs.length} clips at ${resolution} on GPU…`,
    });

    // Positional payload matching the space's /stitch endpoint inputs:
    //   [files, resolution_choice, audio_file, audio_mode, overlay_vol]
    const fileData = uploadedPaths.map((path) => ({
      path,
      meta: { _type: "gradio.FileData" },
    }));
    const data = await callSpaceEndpoint("stitch", [
      fileData,
      resolution,
      null,
      "Keep original audio",
      1,
    ], (message) => {
      onProgress?.({
        stage: "processing",
        progress: null,
        message,
      });
    });
    output = extractGradioOutputValue(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`GPU stitch failed: ${message}`, { cause: err });
  }

  onProgress?.({
    stage: "downloading",
    progress: 80,
    message: "Downloading stitched video…",
  });

  if (output == null) {
    throw new Error(
      "GPU stitch failed: the space returned no output (it may have failed silently — retry after the Space finishes loading).",
    );
  }
  const blob = await downloadSpaceFile(output, "stitched video");

  onProgress?.({ stage: "downloading", progress: 100, message: "Done." });

  return { blob };
}
