/**
 * Utilities for integrating with the HuggingFace Space `1inkusFace/RIFE`
 * to perform per-clip frame interpolation (RIFE) and Boomerang effects.
 *
 * Architecture note: RIFE is applied per-clip, AFTER trimming but BEFORE
 * merging. Running it on the final merged video would cause ugly morphing
 * artifacts across scene cuts.
 */

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

  // Uses the raw Gradio HTTP API with credentials:"omit" rather than
  // @gradio/client — see the note on stitchClipsOnGpu for why the bundled
  // client cannot reach a public HF Space from a deployed browser origin.
  const isBoomerang = mode === "boomerang";

  let output: unknown;
  try {
    onProgress?.({
      stage: "uploading",
      progress: 20,
      message: "Uploading clip to RIFE…",
    });
    const [path] = await uploadFilesToSpace([videoBlob]);

    onProgress?.({
      stage: "processing",
      progress: null,
      message: "Processing with RIFE…",
    });

    // The space's interpolate_video endpoint accepts:
    //   [video (FileData), multiplier ("2"/"4"/"8"), boomerang (bool)]
    const data = await callSpaceEndpoint("interpolate_video", [
      { path, meta: { _type: "gradio.FileData" } },
      String(multiplier),
      isBoomerang,
    ]);
    output = data?.[0];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`RIFE processing failed: ${message}`);
  }

  onProgress?.({
    stage: "downloading",
    progress: 80,
    message: "Downloading processed clip…",
  });

  if (!output) {
    throw new Error("RIFE returned no output.");
  }
  const outputBlob = await downloadSpaceFile(output, "RIFE output");

  onProgress?.({ stage: "downloading", progress: 100, message: "Done." });

  return { blob: outputBlob };
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
    ]);
    output = data?.[0];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`GPU stitch failed: ${message}`);
  }

  onProgress?.({
    stage: "downloading",
    progress: 80,
    message: "Downloading stitched video…",
  });

  if (!output) {
    throw new Error("GPU stitch returned no output.");
  }
  const blob = await downloadSpaceFile(output, "stitched video");

  onProgress?.({ stage: "downloading", progress: 100, message: "Done." });

  return { blob };
}

// ---------------------------------------------------------------------------
// Raw Gradio HTTP API helpers (credentials-omit, CORS-safe for public Spaces)
// ---------------------------------------------------------------------------

/** Public host for the 1inkusFace/RIFE Space (Gradio 5 `/gradio_api` routes). */
const SPACE_BASE_URL = "https://1inkusface-rife.hf.space";
const SPACE_API_PREFIX = "/gradio_api";

/**
 * Upload blobs to the Space and return the server-side file paths Gradio
 * assigns them (used to reference the files in a subsequent endpoint call).
 */
async function uploadFilesToSpace(blobs: Blob[]): Promise<string[]> {
  const form = new FormData();
  blobs.forEach((blob, i) => form.append("files", blob, `clip_${i}.mp4`));

  const response = await fetch(`${SPACE_BASE_URL}${SPACE_API_PREFIX}/upload`, {
    method: "POST",
    body: form,
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Upload to space failed (HTTP ${response.status})`);
  }
  const paths = (await response.json()) as unknown;
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
    throw new Error("Unexpected upload response from space.");
  }
  return paths as string[];
}

/**
 * Invoke a named Gradio endpoint (`api_name`) via the `/call` protocol and
 * return its output `data` array. Posts the input payload, receives an
 * `event_id`, then reads the Server-Sent Events result stream.
 */
async function callSpaceEndpoint(
  apiName: string,
  data: unknown[],
): Promise<unknown[]> {
  const callUrl = `${SPACE_BASE_URL}${SPACE_API_PREFIX}/call/${apiName}`;
  const postRes = await fetch(callUrl, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!postRes.ok) {
    throw new Error(`Space call failed (HTTP ${postRes.status})`);
  }
  const { event_id: eventId } = (await postRes.json()) as { event_id?: string };
  if (!eventId) {
    throw new Error("Space call did not return an event id.");
  }

  const streamRes = await fetch(`${callUrl}/${eventId}`, {
    credentials: "omit",
  });
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`Space result stream failed (HTTP ${streamRes.status})`);
  }
  return readGradioEventStream(streamRes.body);
}

/**
 * Parse a Gradio `/call` Server-Sent Events stream, resolving with the payload
 * of the `complete` event (or rejecting on an `error` event).
 */
async function readGradioEventStream(
  body: ReadableStream<Uint8Array>,
): Promise<unknown[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);

      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (currentEvent === "complete") {
          return JSON.parse(payload) as unknown[];
        }
        if (currentEvent === "error") {
          throw new Error(`Space reported an error: ${payload || "unknown"}`);
        }
      }
    }
  }
  throw new Error("Space result stream ended without a complete event.");
}

/**
 * Download a Gradio file output (a `{ path, url }` FileData object, a bare URL
 * string, or a Blob) as a Blob, resolving relative Space URLs against the host.
 */
async function downloadSpaceFile(output: unknown, label: string): Promise<Blob> {
  if (output instanceof Blob) return output;

  let url: string | undefined;
  if (typeof output === "string") {
    url = output;
  } else if (typeof output === "object" && output !== null) {
    const file = output as { url?: string; path?: string };
    url =
      file.url ??
      (file.path
        ? `${SPACE_BASE_URL}${SPACE_API_PREFIX}/file=${file.path}`
        : undefined);
  }
  if (!url) {
    throw new Error(`Unexpected ${label} output format.`);
  }
  if (url.startsWith("/")) url = `${SPACE_BASE_URL}${url}`;

  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Failed to download ${label} (HTTP ${response.status})`);
  }
  return response.blob();
}
