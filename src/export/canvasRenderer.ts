/**
 * CanvasRenderer — browser-native compositing engine for the hybrid rendering pipeline.
 *
 * Public barrel re-export of canvas-rendering modules:
 * - Audio-reactive analysis helpers
 * - Canvas2D compositor functions (layer-budget / overlay helpers — not a GPU fallback)
 * - Clip and timeline renderers
 */

// Types
export type { RendererOptions, RenderProgress, ProgressCallback, FrameSource } from "./canvasRendererTypes";

// Audio helpers
export { bassLevelFromAnalyserBytes, bassLevelFromWasmBands } from "./canvasRendererAudio";

// Canvas helpers
export { calculateLetterboxRect, computeFadeAlpha, clampOpacity, waitForSeeked } from "./canvasRendererHelpers";

// Layer drawing
export { drawClipLayer, drawTextLayer } from "./canvasRendererLayers";

// Compositing functions
export {
  compositeFrame,
  drawTextOverlays,
  renderTextOverlayCanvas,
  renderTextOverlaysAsync,
} from "./canvasRendererCompositor";

// Clip renderer
export { CanvasRenderer } from "./canvasRendererClip";

// Timeline renderer
export { TimelineCanvas2DRenderer } from "./canvasRendererTimeline";
