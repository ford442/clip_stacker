/**
 * Text-overlay and caption-cue layer construction for the composition
 * planner (`previewComposition.ts`, which keeps `buildPreviewCompositionPlan`
 * as the single entry point). Split out purely to keep each module under the
 * repo's ~700-line convention.
 */

import type { CaptionEntry, TextOverlay, TextOverlayStyle } from '../types';
import { resolveAnimatedTextLayout } from './animatedLayout';
import { normalizeCaptions, resolveCaptionStyle } from './subtitles';
import type { CanvasGeometry, PreviewCaptionLayer, PreviewTextLayer } from './previewCompositionTypes';

export function buildTextLayers(
  overlays: TextOverlay[],
  globalTime: number,
  totalDuration: number,
  geom: CanvasGeometry,
): PreviewTextLayer[] {
  if (overlays.length === 0 || totalDuration <= 0) return [];
  if (globalTime < 0 || globalTime > totalDuration) return [];

  return overlays.map((overlay, index) => {
    const layout = resolveAnimatedTextLayout(
      overlay,
      globalTime,
      totalDuration,
      geom.canvasWidth,
      geom.canvasHeight,
      geom.scale,
    );
    return {
      kind: 'text' as const,
      overlayId: overlay.id,
      overlay,
      timelineIndex: index,
      zIndex: 2000 + index,
      x: layout.x,
      y: layout.y,
      opacity: layout.opacity,
    };
  });
}

/**
 * Caption cues active at `globalTime`, as bottom-centre anchored layers.
 *
 * Captions are *not* clamped to `totalDuration` the way text overlays are —
 * a cue is drawn whenever the playhead is inside it, which is exactly what
 * the CC lane shows and what the ASS burn-in does.
 */
export function buildCaptionLayers(
  captions: CaptionEntry[],
  projectStyle: Partial<TextOverlayStyle> | undefined,
  globalTime: number,
  geom: CanvasGeometry,
): PreviewCaptionLayer[] {
  if (captions.length === 0) return [];
  if (globalTime < 0) return [];

  const layers: PreviewCaptionLayer[] = [];
  const normalized = normalizeCaptions(captions);
  for (let index = 0; index < normalized.length; index++) {
    const entry = normalized[index];
    if (globalTime < entry.startSec || globalTime >= entry.endSec) continue;
    if (!entry.text) continue;

    const style = resolveCaptionStyle(entry, projectStyle);
    layers.push({
      kind: 'caption',
      captionId: entry.id,
      text: entry.text,
      style,
      timelineIndex: index,
      // Above text overlays (2000+): burned-in captions are the last thing
      // drawn on the FFmpeg path too, since they run as a post-pass.
      zIndex: 3000 + index,
      x: style.x * geom.canvasWidth,
      y: style.y * geom.canvasHeight,
      opacity: 1,
    });
  }
  return layers;
}
