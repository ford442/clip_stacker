/**
 * CanvasRenderer — browser-native compositing engine for the hybrid rendering pipeline.
 *
 * Public barrel re-export of canvas-rendering modules:
 * - Audio-reactive analysis helpers
 * - Canvas2D compositor functions
 * - Clip and timeline renderers
 */

// Types
export type { RendererOptions, RenderProgress, ProgressCallback, FrameSource } from "./canvas-renderer-types";

// Audio helpers
export { bassLevelFromAnalyserBytes, bassLevelFromWasmBands } from "./canvas-renderer-audio";

// Canvas helpers
export { calculateLetterboxRect, computeFadeAlpha, clampOpacity, waitForSeeked } from "./canvas-renderer-helpers";

// Layer drawing
export { drawClipLayer, drawTextLayer } from "./canvas-renderer-layers";

// Compositing functions
export {
  compositeFrame,
  drawTextOverlays,
  renderTextOverlayCanvas,
  renderTextOverlaysAsync,
} from "./canvas-renderer-compositor";

// Clip renderer
export { CanvasRenderer } from "./canvas-renderer-clip";

// Timeline renderer
export { TimelineCanvas2DRenderer } from "./canvas-renderer-timeline";
