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
  /**
   * Max time to wait for MediaRecorder to finish after stop() is called.
   * Prevents silent hangs when neither `stop` nor `error` events fire.
   */
  stopTimeoutMs?: number;
}

export interface CaptureHandle {
  /** Underlying MediaRecorder instance (for status inspection). */
  recorder: MediaRecorder;
  /**
   * Rejects when MediaRecorder fails during capture (including mid-recording).
   * Use with Promise.race alongside canvas rendering so failures are not silent.
   */
  onFailure: () => Promise<never>;
  /**
   * Stop recording and return the captured video as a Blob.
   * Resolves once the MediaRecorder 'stop' event fires and all chunks are assembled.
   */
  stop: () => Promise<Blob>;
}

/** Default wait for recorder.onstop after calling MediaRecorder.stop(). */
export const DEFAULT_CAPTURE_STOP_TIMEOUT_MS = 30_000;

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
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_CAPTURE_STOP_TIMEOUT_MS;

  if (mimeType && !MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(`MediaRecorder does not support MIME type "${mimeType}".`);
  }

  const stream = canvas.captureStream(fps);

  const recorderOptions: MediaRecorderOptions = { videoBitsPerSecond };
  if (mimeType) recorderOptions.mimeType = mimeType;

  const recorder = new MediaRecorder(stream, recorderOptions);
  const chunks: Blob[] = [];

  let recordingError: Error | null = null;
  const failureWaiters: Array<(error: Error) => void> = [];
  let stopPromise: Promise<Blob> | null = null;

  const failRecording = (context: string, cause?: DOMException | Error | null): void => {
    if (recordingError) return;
    const detail =
      cause instanceof DOMException || cause instanceof Error
        ? cause.message || cause.name
        : cause
          ? String(cause)
          : "unknown MediaRecorder error";
    recordingError = new Error(`MediaRecorder error (${context}): ${detail}`);
    for (const waiter of failureWaiters) {
      waiter(recordingError);
    }
    failureWaiters.length = 0;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
  };

  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onerror = (e: Event) => {
    const domError = (e as Event & { error?: DOMException }).error ?? null;
    failRecording("onerror", domError);
  };

  // Request chunks every 250 ms so memory doesn't spike on long renders.
  recorder.start(250);

  const onFailure = (): Promise<never> => {
    if (recordingError) return Promise.reject(recordingError);
    return new Promise((_, reject) => {
      failureWaiters.push(reject);
    });
  };

  const stop = (): Promise<Blob> => {
    if (recordingError) return Promise.reject(recordingError);
    if (stopPromise) return stopPromise;

    stopPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        fn();
      };

      const timeoutId = setTimeout(() => {
        failRecording(
          `stop timed out after ${stopTimeoutMs / 1000}s waiting for onstop`,
        );
        settle(() => reject(recordingError!));
      }, stopTimeoutMs);

      if (recordingError) {
        settle(() => reject(recordingError!));
        return;
      }

      recorder.onstop = () => {
        if (recordingError) {
          settle(() => reject(recordingError!));
          return;
        }
        const blob = new Blob(chunks, { type: mimeType || "video/webm" });
        if (blob.size === 0) {
          settle(() =>
            reject(
              new Error(
                "MediaRecorder produced empty output (0 bytes). The encoder may have failed silently.",
              ),
            ),
          );
          return;
        }
        settle(() => resolve(blob));
      };

      recorder.onerror = (e: Event) => {
        const domError = (e as Event & { error?: DOMException }).error ?? null;
        failRecording("onerror during stop", domError);
        settle(() => reject(recordingError!));
      };

      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
        } else if (chunks.length > 0) {
          settle(() =>
            resolve(new Blob(chunks, { type: mimeType || "video/webm" })),
          );
        } else {
          settle(() =>
            reject(
              new Error(
                "MediaRecorder is already inactive and produced no capture data.",
              ),
            ),
          );
        }
      } catch (err) {
        failRecording("stop()", err as Error);
        settle(() => reject(recordingError!));
      }
    });

    return stopPromise;
  };

  return { recorder, onFailure, stop };
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
