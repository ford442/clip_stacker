/**
 * The Inspector's clip form: every editable field as the string the input
 * holds. `useInspectorActions` parses it back into the clip.
 */
export interface ClipValues {
  title: string;
  trimStart: string;
  trimEnd: string;
  videoFadeIn: string;
  videoFadeOut: string;
  audioFadeIn: string;
  audioFadeOut: string;
  // PiP / compositing layout
  layerIndex: string;
  x: string;
  y: string;
  width: string;
  height: string;
  opacity: string;
  /** OverlayBlendMode, or '' for the default (source alpha). */
  overlayBlend: string;
  chromaColor: string;
  chromaSimilarity: string;
  chromaBlend: string;
  volume: string;
  playbackRate: string;
  loopCount: string;
}
