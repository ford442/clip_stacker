/**
 * The one `GPUCanvasContext.configure()` shape: every WebGPU canvas the app
 * owns (preview, export compositor, text fill) uses it. A module of its own
 * so the text-fill chunk does not pull in the preview pipelines.
 */

// Numeric GPUTextureUsage flags (spec values) so this module can load in tests
// without a WebGPU environment.
const GPU_TEX_COPY_SRC = 0x01;
export const GPU_TEX_COPY_DST = 0x02;
export const GPU_TEX_TEXTURE_BINDING = 0x04;
const GPU_TEX_RENDER_ATTACHMENT = 0x10;

// RENDER_ATTACHMENT (we draw into it) + COPY_SRC (VideoFrame/VideoEncoder and
// the finishing pass chain read it back) is all a canvas swapchain texture
// ever needs. COPY_DST / TEXTURE_BINDING are not portable across adapters —
// some reject configure() outright — and nothing here samples or copies into
// the canvas texture; the finishing chain copies FROM it into an offscreen
// ping-pong texture and renders back onto it as a color attachment.
export const CANVAS_TEXTURE_USAGE = GPU_TEX_RENDER_ATTACHMENT | GPU_TEX_COPY_SRC;

/** Shared `GPUCanvasContext.configure()` options (initial configure, resize, and device-recovery reconfigure). */
export function canvasConfiguration(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPUCanvasConfiguration {
  return {
    device,
    format,
    alphaMode: "premultiplied",
    usage: CANVAS_TEXTURE_USAGE,
    colorSpace: "srgb",
    toneMapping: { mode: "standard" },
  };
}
