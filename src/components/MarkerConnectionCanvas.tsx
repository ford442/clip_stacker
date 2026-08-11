import React, { useRef, useEffect, useMemo } from 'react';
import { Clip, SyncMarker } from '../types';
import { getMarkerCoordinates, generateBezierPath } from '../utils/markerMath';
import { VirtualClipLayout } from './timelineClipTypes';
import { useSyncDrag } from '../context/SyncDragContext';

interface MarkerConnectionCanvasProps {
  layouts: VirtualClipLayout[];
  masterMarkers: SyncMarker[];
  pixelsPerSecond: number;
  masterAudioLaneY: number;
  getTrackY: (clipId: string) => number;
}

export default function MarkerConnectionCanvas({
  layouts,
  masterMarkers,
  pixelsPerSecond,
  masterAudioLaneY,
  getTrackY,
}: MarkerConnectionCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const activePathRef = useRef<SVGPathElement>(null);
  const { activeDrag, cancelConnectionDrag } = useSyncDrag();
  
  // Create a quick lookup map for Master Markers to avoid nested loops
  const masterMarkerMap = useMemo(() => new Map(masterMarkers.map(m => [m.id, m])), [masterMarkers]);

  const paths: React.ReactNode[] = [];

  // --- High-Frequency Drag Rendering (Zero React Renders) ---
  useEffect(() => {
    if (!activeDrag || !svgRef.current || !activePathRef.current) return;

    const svgElement = svgRef.current;
    const pathElement = activePathRef.current;
    const { startX, startY } = activeDrag;

    let animationFrameId: number;

    const handlePointerMove = (e: PointerEvent) => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      
      animationFrameId = requestAnimationFrame(() => {
        const rect = svgElement.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;

        const pathData = generateBezierPath(startX, startY, currentX, currentY);
        pathElement.setAttribute('d', pathData);
      });
    };

    const handlePointerUp = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-marker-target]')) {
        cancelConnectionDrag();
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [activeDrag, cancelConnectionDrag]);

  // 1. Draw established connections
  layouts.forEach(layout => {
    const { clip, start: clipLeftPx } = layout;
    clip.syncMarkers?.forEach(videoMarker => {
      if (!videoMarker.linkedId) return;

      const targetMasterMarker = masterMarkerMap.get(videoMarker.linkedId);
      if (!targetMasterMarker) return;

      const trackY = getTrackY(clip.id);
      
      const startPos = getMarkerCoordinates(videoMarker, clip, clipLeftPx, pixelsPerSecond, trackY, masterAudioLaneY);
      const endPos = getMarkerCoordinates(targetMasterMarker, null, 0, pixelsPerSecond, 0, masterAudioLaneY);

      paths.push(
        <path
          key={`${clip.id}-${videoMarker.id}`}
          d={generateBezierPath(startPos.x, startPos.y, endPos.x, endPos.y)}
          fill="none"
          stroke="#00ffff"
          strokeWidth="2"
          strokeDasharray="4 4"
          opacity="0.6"
        />
      );
    });
  });

  return (
    <svg 
      ref={svgRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none', // Critical: lets clicks pass through to the clips!
        zIndex: 50 // Ensures cables render on top of the clips
      }}
    >
      {/* Established Links */}
      {paths}

      {/* Active Dragging Link */}
      {activeDrag && (
        <path
          ref={activePathRef}
          d={generateBezierPath(activeDrag.startX, activeDrag.startY, activeDrag.startX, activeDrag.startY)}
          fill="none"
          stroke="#ff00ff"
          strokeWidth="3"
          filter="drop-shadow(0px 0px 4px rgba(255, 0, 255, 0.8))"
        />
      )}
    </svg>
  );
}
