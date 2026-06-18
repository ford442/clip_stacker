export interface BrowserCapabilities {
  /** WebCodecs API (VideoEncoder / VideoDecoder / VideoFrame) available. */
  webcodecs: boolean;
  /** WebGPU API available. */
  webgpu: boolean;
  /** Hardware-accelerated H.264 VideoEncoder reported as supported. */
  hardwareH264: boolean;
  /** MediaRecorder can produce MP4 container output. */
  mediaRecorderMp4: boolean;
  /** SharedArrayBuffer available (required for FFmpeg.wasm). */
  sharedArrayBuffer: boolean;
  /** requestVideoFrameCallback available on HTMLVideoElement. */
  videoFrameCallback: boolean;
}

let _cached: BrowserCapabilities | null = null;

export async function detectCapabilities(): Promise<BrowserCapabilities> {
  if (_cached) return _cached;

  const sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";

  const webcodecs =
    typeof VideoEncoder !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof VideoFrame !== "undefined";

  let webgpu = false;
  if ("gpu" in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter?.requestDevice();
      webgpu = !!device;
      device?.destroy();
    } catch {
      // navigator.gpu exists but adapter/device creation failed
    }
  }

  const mediaRecorderMp4 =
    typeof MediaRecorder !== "undefined" &&
    (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1,mp4a.40.2") ||
      MediaRecorder.isTypeSupported("video/mp4"));

  const videoFrameCallback =
    "requestVideoFrameCallback" in HTMLVideoElement.prototype;

  let hardwareH264 = false;
  if (webcodecs) {
    try {
      const result = await VideoEncoder.isConfigSupported({
        codec: "avc1.42001e",
        width: 1280,
        height: 720,
        hardwareAcceleration: "prefer-hardware",
      });
      hardwareH264 = result.supported === true;
    } catch {
      // API exists but configuration not supported — keep false
    }
  }

  _cached = {
    webcodecs,
    webgpu,
    hardwareH264,
    mediaRecorderMp4,
    sharedArrayBuffer,
    videoFrameCallback,
  };
  return _cached;
}

// ---------------------------------------------------------------------------
// Preview backend selection
// ---------------------------------------------------------------------------

/** Which compositor drives the live timeline preview. */
export type PreviewBackend = "webgpu" | "canvas2d" | "unavailable";

/**
 * Max simultaneous layers the WebGPU preview path is budgeted for. Beyond this
 * the Canvas2D fallback (which composites layers with plain drawImage calls and
 * has no per-layer bind-group/uniform-buffer cost) is used instead.
 */
export const WEBGPU_LAYER_BUDGET = 16;

/**
 * Choose the preview compositor backend.
 *
 * WebGPU is preferred when available and within the layer budget; otherwise the
 * Canvas2D fallback is used. `unavailable` is only returned when even a 2D
 * context cannot be created (the caller should then show a degraded message).
 */
export function selectPreviewBackend(
  caps: Pick<BrowserCapabilities, "webgpu">,
  layerCount = 0,
  canvas2dAvailable = true,
): PreviewBackend {
  if (caps.webgpu && layerCount <= WEBGPU_LAYER_BUDGET) return "webgpu";
  if (canvas2dAvailable) return "canvas2d";
  return "unavailable";
}

/** Short human-readable label for the active preview backend (UI badge). */
export function previewBackendLabel(backend: PreviewBackend): string {
  switch (backend) {
    case "webgpu":
      return "WebGPU Timeline";
    case "canvas2d":
      return "Canvas2D Timeline";
    default:
      return "Preview unavailable";
  }
}

/** Probe whether a 2D canvas context can be created in this environment. */
export function isCanvas2dAvailable(): boolean {
  try {
    return !!document.createElement("canvas").getContext("2d");
  } catch {
    return false;
  }
}

/** Return a human-readable summary of detected capabilities. */
export function formatCapabilities(caps: BrowserCapabilities): string {
  const lines: string[] = [];
  lines.push(`WebCodecs: ${caps.webcodecs ? "✓" : "✗"}`);
  lines.push(`Hardware H.264: ${caps.hardwareH264 ? "✓" : "✗"}`);
  lines.push(`WebGPU: ${caps.webgpu ? "✓" : "✗"}`);
  lines.push(`MediaRecorder MP4: ${caps.mediaRecorderMp4 ? "✓" : "✗"}`);
  lines.push(`SharedArrayBuffer: ${caps.sharedArrayBuffer ? "✓" : "✗"}`);
  return lines.join(" · ");
}
