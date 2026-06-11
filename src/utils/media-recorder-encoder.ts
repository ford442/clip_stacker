/**
 * MediaRecorder-based canvas capture for the hybrid rendering pipeline.
 *
 * Starts recording a canvas stream via the browser's MediaRecorder API.
 * The resulting Blob contains composited video (no audio) and is later
 * passed to FFmpeg for audio muxing.
 *
 * Usage:
 *   const handle = startCanvasCapture(canvas, { videoBitsPerSecond: 8_000_000 });
 *   // ... render to canvas ...
 *   const videoBlob = await handle.stop();
 */

export interface CaptureOptions {
  /** Desired output frames per second (default 30). */
  fps?: number;
  /**
   * MediaRecorder MIME type. Defaults to the best type supported by the browser
   * (prefers video/mp4 then falls back to video/webm).
   */
  mimeType?: string;
  /** Target video bitrate in bits/s (default 8 Mbps). */
  videoBitsPerSecond?: number;
}

export interface CaptureHandle {
  /** Underlying MediaRecorder instance (for status inspection). */
  recorder: MediaRecorder;
  /**
   * Stop recording and return the captured video as a Blob.
   * Resolves once the MediaRecorder 'stop' event fires and all chunks are assembled.
   */
  stop: () => Promise<Blob>;
}

/**
 * Begin capturing a canvas element via MediaRecorder.
 * @throws if MediaRecorder is not available or the selected MIME type is unsupported.
 */
export function startCanvasCapture(
  canvas: HTMLCanvasElement,
  options: CaptureOptions = {},
): CaptureHandle {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  const fps = options.fps ?? 30;
  const videoBitsPerSecond = options.videoBitsPerSecond ?? 8_000_000;
  const mimeType = options.mimeType ?? getBestMimeType();

  if (mimeType && !MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(`MediaRecorder does not support MIME type "${mimeType}".`);
  }

  const stream = canvas.captureStream(fps);

  const recorderOptions: MediaRecorderOptions = { videoBitsPerSecond };
  if (mimeType) recorderOptions.mimeType = mimeType;

  const recorder = new MediaRecorder(stream, recorderOptions);
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  // Request chunks every 250 ms so memory doesn't spike on long renders.
  recorder.start(250);

  const stop = (): Promise<Blob> =>
    new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType || "video/webm" });
        resolve(blob);
      };
      recorder.onerror = (e: Event) => {
        const err = (e as Event & { error?: DOMException }).error;
        const msg = err?.message ?? "unknown MediaRecorder error";
        reject(new Error(`MediaRecorder error: ${msg}`));
      };
      if (recorder.state !== "inactive") recorder.stop();
    });

  return { recorder, stop };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the best available MediaRecorder MIME type for video.
 * Prefers MP4 (better compatibility with FFmpeg muxing) then falls back to WebM.
 */
export function getBestMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";

  const candidates = [
    "video/mp4;codecs=avc1",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }

  return "video/webm";
}
