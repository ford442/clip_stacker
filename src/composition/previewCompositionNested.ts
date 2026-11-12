/**
 * Nested-sequence expansion for the composition planner.
 *
 * A sequence clip is planned like any clip — its window, fades, opacity,
 * rect and crossfade come out of the ordinary layer builders, and its
 * `sourceTime` is the nested sequence's local time
 * (`parentTime − start + inPoint`). Then, instead of drawing it, the planner
 * runs the plan of the sequence it plays at that time and splices those
 * layers in where the sequence clip sat:
 *
 * - ids are namespaced (`nestedInstanceId`), so each instance has its own
 *   media element / decoder cursor and finds its clip in
 *   `withNestedInstances(clips)`;
 * - z order stays inside the sequence clip's slot (`(z, z + 1)`), so the
 *   nested titles sit under the parent's overlay lanes;
 * - opacity multiplies, and rects (and title positions / sizes) map into the
 *   sequence clip's rect, which is the full frame unless it is a PiP.
 *
 * Not applied to a sequence clip: picture transforms, keys and stabilization
 * (`sanitizeSequenceClip` removes them). A transition into or out of a
 * sequence clip has no single pair of frames to hand the transition shader,
 * so both sides fall back to the crossfade opacities — a dissolve.
 */

import type { Clip, NestedSequenceContent } from '../types';
import {
  NESTED_SEQUENCE_MAX_DEPTH,
  isSequenceClip,
  nestedInstanceId,
} from '../timeline/sequenceResolve';
import type {
  CanvasGeometry,
  PreviewClipLayer,
  PreviewCompositionLayer,
  PreviewPipRect,
  PreviewTextLayer,
} from './previewCompositionTypes';

/** Builds the nested sequence's layers at its local time (bottom → top). */
export type NestedPlanBuilder = (
  content: NestedSequenceContent,
  localTime: number,
  depth: number,
) => PreviewCompositionLayer[];

interface RectMap {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

function rectMapFor(rect: PreviewPipRect, geom: CanvasGeometry): RectMap {
  return {
    x: rect.x,
    y: rect.y,
    sx: geom.canvasWidth > 0 ? rect.width / geom.canvasWidth : 1,
    sy: geom.canvasHeight > 0 ? rect.height / geom.canvasHeight : 1,
  };
}

function isIdentityMap(map: RectMap): boolean {
  return map.x === 0 && map.y === 0 && map.sx === 1 && map.sy === 1;
}

function mapRect(rect: PreviewPipRect, map: RectMap): PreviewPipRect {
  if (isIdentityMap(map)) return rect;
  return {
    x: map.x + rect.x * map.sx,
    y: map.y + rect.y * map.sy,
    width: rect.width * map.sx,
    height: rect.height * map.sy,
  };
}

function mapClipLayer(
  layer: PreviewClipLayer,
  parent: PreviewClipLayer,
  map: RectMap,
  zIndex: number,
): PreviewClipLayer {
  const crossfade = layer.crossfade
    ? {
        ...layer.crossfade,
        outgoingClipId: nestedInstanceId(parent.clipId, layer.crossfade.outgoingClipId),
        incomingClipId: nestedInstanceId(parent.clipId, layer.crossfade.incomingClipId),
      }
    : null;
  return {
    ...layer,
    clipId: nestedInstanceId(parent.clipId, layer.clipId),
    // Overlay lanes of the parent sit above everything inside it.
    kind: parent.kind === 'pip' ? 'pip' : layer.kind,
    zIndex,
    opacity: layer.opacity * parent.opacity,
    rect: mapRect(layer.rect, map),
    crossfade,
  };
}

function mapTextLayer(
  layer: PreviewTextLayer,
  parent: PreviewClipLayer,
  map: RectMap,
  zIndex: number,
  localTime: number,
): PreviewTextLayer {
  const scaled = !isIdentityMap(map);
  const overlayId = nestedInstanceId(parent.clipId, layer.overlayId);
  return {
    ...layer,
    overlayId,
    // Namespaced like the layer, so per-overlay caches (glyph masks) keep
    // each placement of a sequence apart.
    overlay: {
      ...layer.overlay,
      id: overlayId,
      ...(scaled ? { fontsize: layer.overlay.fontsize * Math.min(map.sx, map.sy) } : {}),
    },
    zIndex,
    x: map.x + layer.x * map.sx,
    y: map.y + layer.y * map.sy,
    opacity: layer.opacity * parent.opacity,
    // Scrolling and shader fills animate on the sequence's own clock.
    time: layer.time ?? localTime,
  };
}

/** The nested layers that replace one sequence-clip layer. */
function nestedLayersFor(
  parent: PreviewClipLayer,
  content: NestedSequenceContent,
  geom: CanvasGeometry,
  depth: number,
  buildNested: NestedPlanBuilder,
): PreviewCompositionLayer[] {
  const localTime = parent.sourceTime;
  const inner = buildNested(content, localTime, depth + 1);
  if (inner.length === 0) return [];
  const map = rectMapFor(parent.rect, geom);
  const slot = inner.length + 1;
  const out: PreviewCompositionLayer[] = [];
  inner.forEach((layer, rank) => {
    const zIndex = parent.zIndex + (rank + 1) / slot;
    if (layer.kind === 'text') out.push(mapTextLayer(layer, parent, map, zIndex, localTime));
    else if (layer.kind === 'base' || layer.kind === 'pip') {
      out.push(mapClipLayer(layer, parent, map, zIndex));
    }
    // Captions are project-wide: a nested sequence never carries them.
  });
  return out;
}

/**
 * Replace every sequence-clip layer in `layers` with the layers of the
 * sequence it plays. A sequence clip with no resolved content (unknown
 * sequence, a cycle, or past {@link NESTED_SEQUENCE_MAX_DEPTH}) draws
 * nothing. Returns `layers` itself when no layer is a sequence clip.
 */
export function expandNestedClipLayers(
  layers: PreviewClipLayer[],
  timelineClips: Clip[],
  geom: CanvasGeometry,
  depth: number,
  buildNested: NestedPlanBuilder,
): PreviewCompositionLayer[] {
  if (!timelineClips.some(isSequenceClip)) return layers;
  const clipsById = new Map(timelineClips.map((clip) => [clip.id, clip]));
  const out: PreviewCompositionLayer[] = [];
  for (const layer of layers) {
    const clip = clipsById.get(layer.clipId);
    if (!clip || !isSequenceClip(clip)) {
      out.push(layer);
      continue;
    }
    if (!clip.nested || depth + 1 > NESTED_SEQUENCE_MAX_DEPTH) continue;
    out.push(...nestedLayersFor(layer, clip.nested, geom, depth, buildNested));
  }
  return out;
}
