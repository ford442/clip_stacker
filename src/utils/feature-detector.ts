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
