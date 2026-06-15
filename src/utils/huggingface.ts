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
