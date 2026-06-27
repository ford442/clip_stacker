/**
 * Utilities for integrating with the HuggingFace Space `1inkusFace/RIFE`
 * to perform per-clip frame interpolation (RIFE) and Boomerang effects.
 *
 * Architecture note: RIFE is applied per-clip, AFTER trimming but BEFORE
 * merging. Running it on the final merged video would cause ugly morphing
 * artifacts across scene cuts.
 */

import { Client } from "@gradio/client";

export type RifeMode = "interpolation" | "boomerang";

export interface RifeProgressEvent {
  stage: "uploading" | "processing" | "downloading";
  /** 0–100 progress percentage, or null if indeterminate */
  progress: number | null;
  message?: string;
}

export interface RifeResult {
  blob: Blob;
}

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
): Promise<RifeResult> {
  onProgress?.({
    stage: "uploading",
    progress: 0,
    message: "Connecting to RIFE space…",
  });

  const client = await Client.connect("1inkusFace/RIFE");

  onProgress?.({
    stage: "uploading",
    progress: 20,
    message: "Uploading clip to RIFE…",
  });

  // The 1inkusFace/RIFE space exposes its frame-interpolation endpoint as
  // "/interpolate_video", accepting:
  //   - video: file handle / blob
  //   - multiplier: string ("2", "4", or "8")
  //   - boomerang: boolean
  const isBoomerang = mode === "boomerang";

  let result: { data: unknown[] };
  try {
    onProgress?.({
      stage: "processing",
      progress: null,
      message: "Processing with RIFE…",
    });

    result = (await client.predict("/interpolate_video", {
      video: videoBlob,
      multiplier: String(multiplier),
      boomerang: isBoomerang,
    })) as { data: unknown[] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`RIFE processing failed: ${message}`);
  }

  onProgress?.({
    stage: "downloading",
    progress: 80,
    message: "Downloading processed clip…",
  });

  // The space returns a file URL or a blob-like object in result.data[0]
  const output = result.data?.[0];
  if (!output) {
    throw new Error("RIFE returned no output.");
  }

  let outputBlob: Blob;
  if (output instanceof Blob) {
    outputBlob = output;
  } else if (typeof output === "string") {
    // Could be a URL
    const response = await fetch(output);
    if (!response.ok) {
      throw new Error(
        `Failed to download RIFE output (HTTP ${response.status})`,
      );
    }
    outputBlob = await response.blob();
  } else if (typeof output === "object" && output !== null && "url" in output) {
    const url = (output as { url: string }).url;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to download RIFE output (HTTP ${response.status})`,
      );
    }
    outputBlob = await response.blob();
  } else {
    throw new Error("Unexpected RIFE output format.");
  }

  onProgress?.({ stage: "downloading", progress: 100, message: "Done." });

  return { blob: outputBlob };
}

/**
 * Resolve a Gradio prediction output (Blob, URL string, or `{ url }` object)
 * into a Blob, downloading it if necessary.
 */
async function resolveGradioFileOutput(
  output: unknown,
  label: string,
): Promise<Blob> {
  if (output instanceof Blob) return output;
  if (typeof output === "string") {
    const response = await fetch(output);
    if (!response.ok) {
      throw new Error(`Failed to download ${label} (HTTP ${response.status})`);
    }
    return response.blob();
  }
  if (typeof output === "object" && output !== null && "url" in output) {
    const url = (output as { url: string }).url;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${label} (HTTP ${response.status})`);
    }
    return response.blob();
  }
  throw new Error(`Unexpected ${label} output format.`);
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
 * @param clipBlobs  - Trimmed video clips, in timeline order.
 * @param resolution - Target resolution as "WIDTHxHEIGHT" (e.g. "1920x1080").
 * @param onProgress - Optional progress callback.
 */
export async function stitchClipsOnGpu(
  clipBlobs: Blob[],
  resolution: string,
  onProgress?: (event: RifeProgressEvent) => void,
): Promise<GpuStitchResult> {
  if (clipBlobs.length === 0) {
    throw new Error("No video clips to stitch.");
  }

  onProgress?.({
    stage: "uploading",
    progress: 0,
    message: "Connecting to stitch space…",
  });

  const client = await Client.connect("1inkusFace/RIFE");

  onProgress?.({
    stage: "uploading",
    progress: 20,
    message: `Uploading ${clipBlobs.length} clip${clipBlobs.length > 1 ? "s" : ""} to GPU…`,
  });

  let result: { data: unknown[] };
  try {
    onProgress?.({
      stage: "processing",
      progress: null,
      message: `Stitching ${clipBlobs.length} clips at ${resolution} on GPU…`,
    });

    // Positional payload matching the space's /stitch endpoint inputs:
    //   [files, resolution_choice, audio_file, audio_mode, overlay_vol]
    result = (await client.predict("/stitch", [
      clipBlobs,
      resolution,
      null,
      "Keep original audio",
      1,
    ])) as { data: unknown[] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`GPU stitch failed: ${message}`);
  }

  onProgress?.({
    stage: "downloading",
    progress: 80,
    message: "Downloading stitched video…",
  });

  const output = result.data?.[0];
  if (!output) {
    throw new Error("GPU stitch returned no output.");
  }
  const blob = await resolveGradioFileOutput(output, "stitched video");

  onProgress?.({ stage: "downloading", progress: 100, message: "Done." });

  return { blob };
}
