import { Clip, SyncMarker } from '../types';

export interface MarkerCoordinates {
  x: number;
  y: number;
}

/**
 * Calculates the absolute X/Y coordinates for a marker on the virtual canvas.
 */
export function getMarkerCoordinates(
  marker: SyncMarker,
  clip: Clip | null, // Null if it's a Master Audio Marker
  clipLeftPx: number, // The layout.start pixel offset of the clip block
  pixelsPerSecond: number,
  trackY: number, // The absolute Y position of the track
  masterAudioLaneY: number
): MarkerCoordinates {
  
  if (!clip) {
    // It's a Master Audio Marker
    return {
      x: marker.time * pixelsPerSecond,
      y: masterAudioLaneY
    };
  }

  // It's a Video Clip Marker
  return {
    // Local time is converted to pixels and added to the clip's global left offset
    x: clipLeftPx + (marker.time * pixelsPerSecond),
    y: trackY + 24 // Offset to reach the SyncMarkerLane within the track
  };
}

/**
 * Generates a smooth, node-style cubic Bezier curve string for SVG <path>.
 */
export function generateBezierPath(startX: number, startY: number, endX: number, endY: number): string {
  // Calculate a dynamic vertical control point offset based on horizontal distance
  const verticalOffset = Math.abs(endY - startY) * 0.5;
  
  return `M ${startX} ${startY} C ${startX} ${startY + verticalOffset}, ${endX} ${endY - verticalOffset}, ${endX} ${endY}`;
}
