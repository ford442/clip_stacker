import { useStore } from 'zustand';
import type { Dispatch, SetStateAction } from 'react';
import type { Clip, ClipGroup, ClipTransition, TextOverlay } from '../types';
import type { EditSnapshot } from '../utils/editHistory';
import { editorStore } from '../store/editorStore';

export interface UseEditHistoryResult {
  clips: Clip[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  selectedClipId: string | null;
  setClips: Dispatch<SetStateAction<Clip[]>>;
  setClipGroups: Dispatch<SetStateAction<ClipGroup[]>>;
  setTransitions: Dispatch<SetStateAction<ClipTransition[]>>;
  setTextOverlays: Dispatch<SetStateAction<TextOverlay[]>>;
  setSelectedClipId: Dispatch<SetStateAction<string | null>>;
  /** Push the current state onto the undo stack (call before a discrete edit). */
  pushHistory: () => void;
  /**
   * Coalesce rapid edits (inspector sliders, text fields) into one undo step.
   * @param group Stable key for the editing session (e.g. `inspector:${clipId}`).
   */
  pushHistoryDebounced: (group: string, debounceMs?: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Replace editing state and clear undo/redo stacks (e.g. after project load). */
  resetHistory: (snapshot: EditSnapshot) => void;
}

/**
 * React binding over {@link editorStore}. The editing state and undo/redo logic
 * now live in a Zustand store (#144); this hook keeps the previous prop-drilling
 * API for the App shell. Components that only render a slice should prefer the
 * granular selectors (`useEditorClips`, `useSelectedClipId`, …) to avoid
 * re-rendering on unrelated edits.
 */
export function useEditHistory(): UseEditHistoryResult {
  const clips = useStore(editorStore, (s) => s.clips);
  const clipGroups = useStore(editorStore, (s) => s.clipGroups);
  const transitions = useStore(editorStore, (s) => s.transitions);
  const textOverlays = useStore(editorStore, (s) => s.textOverlays);
  const selectedClipId = useStore(editorStore, (s) => s.selectedClipId);
  const canUndo = useStore(editorStore, (s) => s.undoDepth > 0);
  const canRedo = useStore(editorStore, (s) => s.redoDepth > 0);

  // Actions are created once when the store is instantiated, so they are stable
  // across renders and safe to read directly from the store's snapshot.
  const {
    setClips,
    setClipGroups,
    setTransitions,
    setTextOverlays,
    setSelectedClipId,
    pushHistory,
    pushHistoryDebounced,
    undo,
    redo,
    resetHistory,
  } = editorStore.getState();

  return {
    clips,
    clipGroups,
    transitions,
    textOverlays,
    selectedClipId,
    setClips,
    setClipGroups,
    setTransitions,
    setTextOverlays,
    setSelectedClipId,
    pushHistory,
    pushHistoryDebounced,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
  };
}
