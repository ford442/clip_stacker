import React, { createContext, useContext, useState, useCallback } from 'react';
import { SyncMarker } from '../types';
import { editorActions } from '../store';
import { useEditorClips } from '../store';

interface DragState {
  sourceMarker: SyncMarker;
  sourceClipId: string | null; // null if dragging from master audio
  startX: number;
  startY: number;
}

interface SyncDragContextType {
  activeDrag: DragState | null;
  startConnectionDrag: (marker: SyncMarker, sourceClipId: string | null, startX: number, startY: number) => void;
  cancelConnectionDrag: () => void;
  finalizeConnection: (targetMarkerId: string) => void;
}

const SyncDragContext = createContext<SyncDragContextType | null>(null);

export const useSyncDrag = () => {
  const ctx = useContext(SyncDragContext);
  if (!ctx) throw new Error('useSyncDrag must be used within a SyncDragProvider');
  return ctx;
};

export const SyncDragProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeDrag, setActiveDrag] = useState<DragState | null>(null);
  const clips = useEditorClips();

  const startConnectionDrag = useCallback((marker: SyncMarker, sourceClipId: string | null, startX: number, startY: number) => {
    setActiveDrag({ sourceMarker: marker, sourceClipId, startX, startY });
  }, []);

  const cancelConnectionDrag = useCallback(() => {
    setActiveDrag(null);
  }, []);

  const finalizeConnection = useCallback((targetMarkerId: string) => {
    if (!activeDrag) return;
    
    // Link the markers
    // If the source was a video clip, store the link on the clip's marker
    if (activeDrag.sourceClipId) {
      editorActions.setClips(prevClips => 
        prevClips.map(c => {
          if (c.id === activeDrag.sourceClipId) {
            const updatedMarkers = c.syncMarkers?.map(m => 
              m.id === activeDrag.sourceMarker.id 
                ? { ...m, linkedId: targetMarkerId } 
                : m
            ) ?? [];
            return { ...c, syncMarkers: updatedMarkers };
          }
          return c;
        })
      );
    } else {
      // If the source was the master audio, we need to find the target video clip and its marker
      // and set the link there instead, since we store relationships on the clips.
      editorActions.setClips(prevClips => 
        prevClips.map(c => {
          if (!c.syncMarkers) return c;
          let changed = false;
          const updatedMarkers = c.syncMarkers.map(m => {
            if (m.id === targetMarkerId) {
              changed = true;
              return { ...m, linkedId: activeDrag.sourceMarker.id };
            }
            return m;
          });
          return changed ? { ...c, syncMarkers: updatedMarkers } : c;
        })
      );
    }
    
    setActiveDrag(null);
  }, [activeDrag]);

  return (
    <SyncDragContext.Provider value={{ activeDrag, startConnectionDrag, cancelConnectionDrag, finalizeConnection }}>
      {children}
    </SyncDragContext.Provider>
  );
};
