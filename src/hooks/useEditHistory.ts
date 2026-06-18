import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { Clip, ClipGroup, ClipTransition, TextOverlay } from '../types';
import {
  cloneSnapshot,
  mergeClipUrls,
  revokeOrphanedUrls,
  syncClipGroups,
  trimHistoryStack,
  type EditSnapshot,
} from '../utils/editHistory';

const DEFAULT_DEBOUNCE_MS = 400;

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

export function useEditHistory(): UseEditHistoryResult {
  const [clips, setClipsState] = useState<Clip[]>([]);
  const [clipGroups, setClipGroupsState] = useState<ClipGroup[]>([]);
  const [transitions, setTransitionsState] = useState<ClipTransition[]>([]);
  const [textOverlays, setTextOverlaysState] = useState<TextOverlay[]>([]);
  const [selectedClipId, setSelectedClipIdState] = useState<string | null>(null);
  const [stackSizes, setStackSizes] = useState({ undo: 0, redo: 0 });

  const undoStackRef = useRef<EditSnapshot[]>([]);
  const redoStackRef = useRef<EditSnapshot[]>([]);
  const isRestoringRef = useRef(false);
  const debounceSessionsRef = useRef<Map<string, boolean>>(new Map());
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const syncStackSizes = useCallback(() => {
    setStackSizes({
      undo: undoStackRef.current.length,
      redo: redoStackRef.current.length,
    });
  }, []);

  const getSnapshot = useCallback(
    (): EditSnapshot => ({
      clips,
      clipGroups,
      transitions,
      textOverlays,
      selectedClipId,
    }),
    [clips, clipGroups, transitions, textOverlays, selectedClipId],
  );

  const applySnapshot = useCallback(
    (snapshot: EditSnapshot) => {
      isRestoringRef.current = true;
      try {
        const previousClips = clips;
        const mergedClips = mergeClipUrls(snapshot.clips, previousClips);
        revokeOrphanedUrls(previousClips, mergedClips);
        const syncedGroups = syncClipGroups(snapshot.clipGroups, mergedClips);

        setClipsState(mergedClips);
        setClipGroupsState(syncedGroups);
        setTransitionsState(snapshot.transitions.map((transition) => ({ ...transition })));
        setTextOverlaysState(snapshot.textOverlays.map((overlay) => ({ ...overlay })));
        setSelectedClipIdState(snapshot.selectedClipId);
      } finally {
        isRestoringRef.current = false;
      }
    },
    [clips],
  );

  const pushHistory = useCallback(() => {
    if (isRestoringRef.current) return;

    const snapshot = cloneSnapshot(getSnapshot());
    undoStackRef.current.push(snapshot);
    trimHistoryStack(undoStackRef.current);
    redoStackRef.current = [];
    syncStackSizes();
  }, [getSnapshot, syncStackSizes]);

  const pushHistoryDebounced = useCallback(
    (group: string, debounceMs = DEFAULT_DEBOUNCE_MS) => {
      if (isRestoringRef.current) return;

      const sessions = debounceSessionsRef.current;
      if (!sessions.get(group)) {
        pushHistory();
        sessions.set(group, true);
      }

      const timers = debounceTimersRef.current;
      const existingTimer = timers.get(group);
      if (existingTimer) clearTimeout(existingTimer);

      timers.set(
        group,
        setTimeout(() => {
          sessions.set(group, false);
          timers.delete(group);
        }, debounceMs),
      );
    },
    [pushHistory],
  );

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;

    const current = cloneSnapshot(getSnapshot());
    redoStackRef.current.push(current);
    trimHistoryStack(redoStackRef.current);

    const previous = undoStackRef.current.pop()!;
    applySnapshot(previous);
    syncStackSizes();
  }, [applySnapshot, getSnapshot, syncStackSizes]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;

    const current = cloneSnapshot(getSnapshot());
    undoStackRef.current.push(current);
    trimHistoryStack(undoStackRef.current);

    const next = redoStackRef.current.pop()!;
    applySnapshot(next);
    syncStackSizes();
  }, [applySnapshot, getSnapshot, syncStackSizes]);

  const resetHistory = useCallback(
    (snapshot: EditSnapshot) => {
      undoStackRef.current = [];
      redoStackRef.current = [];
      debounceSessionsRef.current.clear();
      for (const timer of debounceTimersRef.current.values()) {
        clearTimeout(timer);
      }
      debounceTimersRef.current.clear();

      isRestoringRef.current = true;
      try {
        const mergedClips = mergeClipUrls(snapshot.clips, clips);
        revokeOrphanedUrls(clips, mergedClips);
        setClipsState(mergedClips);
        setClipGroupsState(syncClipGroups(snapshot.clipGroups, mergedClips));
        setTransitionsState(snapshot.transitions.map((transition) => ({ ...transition })));
        setTextOverlaysState(snapshot.textOverlays.map((overlay) => ({ ...overlay })));
        setSelectedClipIdState(snapshot.selectedClipId);
      } finally {
        isRestoringRef.current = false;
      }
      syncStackSizes();
    },
    [clips, syncStackSizes],
  );

  return {
    clips,
    clipGroups,
    transitions,
    textOverlays,
    selectedClipId,
    setClips: setClipsState,
    setClipGroups: setClipGroupsState,
    setTransitions: setTransitionsState,
    setTextOverlays: setTextOverlaysState,
    setSelectedClipId: setSelectedClipIdState,
    pushHistory,
    pushHistoryDebounced,
    undo,
    redo,
    canUndo: stackSizes.undo > 0,
    canRedo: stackSizes.redo > 0,
    resetHistory,
  };
}
