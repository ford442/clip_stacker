import React, { useRef, useState, useCallback, useEffect } from 'react';
import { SyncMarker } from '../types';
import { useSyncDrag } from '../context/SyncDragContext';

interface SyncMarkerLaneProps {
  markers: SyncMarker[];
  duration: number;       // Total duration of the track/clip in seconds
  width: number;          // Pixel width of the lane
  laneType: 'audio' | 'video';
  clipId: string | null; // Null if master audio
  onUpdateMarkers: (markers: SyncMarker[]) => void;
  onMarkerSelect?: (marker: SyncMarker) => void;
}

export default function SyncMarkerLane({
  markers,
  duration,
  width,
  laneType,
  clipId,
  onUpdateMarkers,
  onMarkerSelect
}: SyncMarkerLaneProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const { startConnectionDrag, activeDrag, finalizeConnection } = useSyncDrag();

  // --- Math Helpers ---
  const timeToX = (time: number) => (time / duration) * width;
  const xToTime = (x: number) => Math.max(0, Math.min(duration, (x / width) * duration));

  // --- Interaction Handlers ---
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!laneRef.current) return;
    const rect = laneRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    
    const newMarker: SyncMarker = {
      id: Math.random().toString(36).substring(7),
      time: xToTime(x),
      text: 'New Cue'
    };
    
    // In a real implementation, you might snap this time to the nearest 
    // beatTimestamp provided by your offlineAnalysis.ts engine.
    onUpdateMarkers([...markers, newMarker].sort((a, b) => a.time - b.time));
  };

  const handlePointerDown = (e: React.PointerEvent, marker: SyncMarker) => {
    e.stopPropagation();
    
    // Determine if user clicked precisely on the flag tag or the line itself
    const target = e.target as HTMLElement;
    if (target.classList.contains('marker-flag-tag')) {
      // User wants to draw a cable from the flag
      if (!laneRef.current) return;
      const rect = laneRef.current.getBoundingClientRect();
      const parentRect = laneRef.current.parentElement?.getBoundingClientRect();
      
      // We pass the start coordinates relative to the scroll container or window depending on SVG mounting
      // The simplest way to normalize is to pass coordinates that the SVG overlay can translate,
      // or we just pass the exact layout coords. For simplicity in the V1 prototype, 
      // let MarkerConnectionCanvas handle the math based on marker ID.
      // But we still need an absolute screen coordinate to start the bezier curve.
      startConnectionDrag(marker, clipId, e.clientX, e.clientY);
      return;
    }
    
    setDraggedId(marker.id);
    if (onMarkerSelect) onMarkerSelect(marker);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!draggedId || !laneRef.current) return;
    const rect = laneRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    
    const updatedMarkers = markers.map(m => 
      m.id === draggedId ? { ...m, time: xToTime(x) } : m
    ).sort((a, b) => a.time - b.time);
    
    onUpdateMarkers(updatedMarkers);
  }, [draggedId, markers, duration, width, onUpdateMarkers]);

  const handlePointerUp = useCallback(() => {
    setDraggedId(null);
  }, []);

  useEffect(() => {
    if (draggedId) {
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    }
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [draggedId, handlePointerMove, handlePointerUp]);

  return (
    <div 
      ref={laneRef}
      onDoubleClick={handleDoubleClick}
      style={{ 
        position: 'relative', 
        width, 
        height: '24px', 
        backgroundColor: 'rgba(0, 0, 0, 0.2)',
        borderBottom: '1px solid #333',
        cursor: 'text'
      }}
    >
      {markers.map(marker => (
        <div
          key={marker.id}
          data-marker-target="true"
          onPointerDown={(e) => handlePointerDown(e, marker)}
          onPointerUp={(e) => {
            if (activeDrag && activeDrag.sourceMarker.id !== marker.id) {
              e.stopPropagation();
              finalizeConnection(marker.id);
            }
          }}
          style={{
            position: 'absolute',
            left: `${timeToX(marker.time)}px`,
            top: 0,
            bottom: 0,
            width: '2px',
            backgroundColor: laneType === 'audio' ? '#00ffff' : '#ff00ff',
            cursor: 'ew-resize',
            transform: 'translateX(-50%)',
          }}
        >
          {/* Marker Flag / Text Tag */}
          <div 
            className="marker-flag-tag"
            style={{
            position: 'absolute',
            top: '2px',
            left: '4px',
            fontSize: '10px',
            color: '#fff',
            backgroundColor: 'rgba(0,0,0,0.6)',
            padding: '2px 4px',
            borderRadius: '2px',
            whiteSpace: 'nowrap',
            cursor: 'crosshair', // Distinct cursor to indicate linking
            pointerEvents: 'auto'
          }}>
            {marker.text} {marker.linkedId && '🔗'}
          </div>
        </div>
      ))}
    </div>
  );
}
