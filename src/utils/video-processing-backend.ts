/**
 * Abstraction layer for video processing backends.
 *
 * This module defines a common interface for frame-interpolation / RIFE
 * processing so that the frontend can switch between the public HuggingFace
 * Space backend and a future self-hosted Contabo backend without changing any
 * call-site code.
 *
 * ## Backends
 *
 * | Class                   | Backend                            | Status   |
 * |-------------------------|------------------------------------|----------|
 * | HuggingFaceRifeBackend  | `1inkusFace/RIFE` HuggingFace Space | Live     |
 * | SelfHostedRifeBackend   | Self-hosted / Contabo endpoint      | Planned  |
 *
 * ## Usage
 *
 * ```ts
 * import { createVideoProcessingBackend } from './video-processing-backend';
 *
 * const backend = createVideoProcessingBackend(selfHostedUrl ?? null);
 * const { blob } = await backend.processClip(trimmedBlob, { multiplier: 2, mode: 'interpolation' });
 * ```
 */

import { processClipWithRIFE } from './huggingface';
import type { RifeMode, RifeProgressEvent } from './huggingface';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface VideoProcessingOptions {
  /** Frame-rate multiplier: 2× or 4× interpolation. */
  multiplier: 2 | 4;
  /** Processing mode: smooth motion interpolation or boomerang loop. */
  mode: RifeMode;
}

export interface VideoProcessingProgressEvent {
  stage: string;
  /** 0–100 percentage or null when indeterminate. */
  progress: number | null;
  message?: string;
}

export interface VideoProcessingResult {
  blob: Blob;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Common interface for all video processing backends.
 *
 * Backends are stateless and can be created multiple times safely.
 */
export interface VideoProcessingBackend {
  /** Human-readable name for logging / UI display. */
  readonly name: string;

  /**
   * Returns true when this backend is ready to accept requests.
   * For HuggingFace this is always true; for self-hosted backends it may
   * do a health-check against the server.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Process a video clip through the backend's RIFE pipeline.
   *
   * @param videoBlob  - The (already-trimmed) source video.
   * @param options    - Processing parameters.
   * @param onProgress - Optional real-time progress callback.
   */
  processClip(
    videoBlob: Blob,
    options: VideoProcessingOptions,
    onProgress?: (event: VideoProcessingProgressEvent) => void,
  ): Promise<VideoProcessingResult>;
}

// ---------------------------------------------------------------------------
// HuggingFace backend (current default)
// ---------------------------------------------------------------------------

/**
 * RIFE backend that delegates to the `1inkusFace/RIFE` HuggingFace Space.
 * This is the current production backend — no server infrastructure required.
 */
export class HuggingFaceRifeBackend implements VideoProcessingBackend {
  readonly name = 'HuggingFace RIFE (1inkusFace/RIFE)';

  async isAvailable(): Promise<boolean> {
    // The Space is public and always reachable when the user has internet access.
    return true;
  }

  async processClip(
    videoBlob: Blob,
    options: VideoProcessingOptions,
    onProgress?: (event: VideoProcessingProgressEvent) => void,
  ): Promise<VideoProcessingResult> {
    let progressAdapter: ((event: RifeProgressEvent) => void) | undefined;
    if (onProgress) {
      progressAdapter = (event: RifeProgressEvent) => {
        onProgress({
          stage: event.stage,
          progress: event.progress,
          message: event.message,
        });
      };
    }

    return processClipWithRIFE(
      videoBlob,
      options.multiplier,
      options.mode,
      progressAdapter,
    );
  }
}

// ---------------------------------------------------------------------------
// Self-hosted / Contabo backend (planned)
// ---------------------------------------------------------------------------

/**
 * RIFE backend for a self-hosted endpoint (e.g. on a Contabo GPU server).
 *
 * This is a placeholder for the future self-hosted pipeline. When implemented,
 * it will POST the video blob to `endpointUrl/predict` and expect the same
 * response shape as the HuggingFace Space API so the calling code needs no
 * changes.
 *
 * Expected API contract (to be implemented on the server):
 *   POST <endpointUrl>/predict
 *     Content-Type: multipart/form-data
 *     Fields: video (Blob), multiplier (number), boomerang (boolean)
 *   Response: JSON `{ data: [{ url: string }] }` — same as Gradio
 *
 * Background tasks (e.g. queued RIFE jobs) are out of scope for the initial
 * drop and will be added in a follow-up PR alongside the Contabo worker setup.
 */
export class SelfHostedRifeBackend implements VideoProcessingBackend {
  readonly name: string;

  constructor(private readonly endpointUrl: string) {
    this.name = `Self-hosted RIFE (${endpointUrl})`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpointUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async processClip(
    videoBlob: Blob,
    options: VideoProcessingOptions,
    onProgress?: (event: VideoProcessingProgressEvent) => void,
  ): Promise<VideoProcessingResult> {
    onProgress?.({ stage: 'uploading', progress: 0, message: 'Uploading to self-hosted RIFE…' });

    const form = new FormData();
    form.append('video', videoBlob, 'clip.mp4');
    form.append('multiplier', String(options.multiplier));
    form.append('boomerang', String(options.mode === 'boomerang'));

    onProgress?.({ stage: 'processing', progress: null, message: 'Processing with self-hosted RIFE…' });

    const response = await fetch(`${this.endpointUrl}/predict`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Self-hosted RIFE request failed: HTTP ${response.status}`);
    }

    const result = (await response.json()) as { data?: Array<{ url?: string } | string> };
    const output = result.data?.[0];

    if (!output) {
      throw new Error('Self-hosted RIFE returned no output.');
    }

    onProgress?.({ stage: 'downloading', progress: 80, message: 'Downloading processed clip…' });

    let outputBlob: Blob;
    if (output instanceof Blob) {
      outputBlob = output;
    } else if (typeof output === 'string') {
      const res = await fetch(output);
      if (!res.ok) throw new Error(`Failed to download self-hosted RIFE output (HTTP ${res.status})`);
      outputBlob = await res.blob();
    } else if (typeof output === 'object' && 'url' in output && output.url) {
      const res = await fetch(output.url);
      if (!res.ok) throw new Error(`Failed to download self-hosted RIFE output (HTTP ${res.status})`);
      outputBlob = await res.blob();
    } else {
      throw new Error('Unexpected self-hosted RIFE output format.');
    }

    onProgress?.({ stage: 'downloading', progress: 100, message: 'Done.' });
    return { blob: outputBlob };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate video processing backend.
 *
 * When `selfHostedUrl` is provided and non-empty, returns a
 * `SelfHostedRifeBackend` instance; otherwise returns the default
 * `HuggingFaceRifeBackend`.
 *
 * @param selfHostedUrl - Optional URL for a self-hosted RIFE endpoint.
 */
export function createVideoProcessingBackend(
  selfHostedUrl?: string | null,
): VideoProcessingBackend {
  if (selfHostedUrl && selfHostedUrl.trim().length > 0) {
    return new SelfHostedRifeBackend(selfHostedUrl.trim());
  }
  return new HuggingFaceRifeBackend();
}
