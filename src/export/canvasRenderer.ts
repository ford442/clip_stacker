/**
 * CanvasRenderer — browser-native compositing engine for the hybrid rendering pipeline.
 *
 * Public barrel re-export of canvas-rendering modules:
 * - Audio-reactive analysis helpers
 * - Canvas2D compositor functions (layer-budget / overlay helpers — not a GPU fallback)
 * - Clip and timeline renderers
 */

// Types
export type {    FrameSource } from "./canvasRendererTypes";

// Audio helpers
export { bassLevelFromAnalyserBytes, bassLevelFromWasmBands } from "./canvasRendererAudio";

// Canvas helpers
;

// Layer drawing
;

// Compositing functions
export {
  compositeFrame,
  drawTextOverlays,
  
  renderTextOverlaysAsync,
} from "./canvasRendererCompositor";

// Clip renderer
export { CanvasRenderer } from "./canvasRendererClip";

// Timeline renderer
;
