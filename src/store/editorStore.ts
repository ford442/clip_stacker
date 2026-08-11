import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Clip, ClipGroup, ClipTransition, MasterAudio, TextOverlay, Track } from '../types';
import { getEffectiveTimelineClips } from '../utils/timelineClips';
import { createDefaultTracks } from '../utils/trackModel';
import {
  cloneSnapshot,
  mergeClipUrls,
  revokeOrphanedUrls,
  syncClipGroups,
  trimHistoryStack,
  type EditSnapshot,
} from '../utils/editHistory';
import { cloneTracks } from '../utils/trackModel';

/**
 * Durable editing state (#144).
 *
 * The timeline's core data — clips, clip groups, transitions, text overlays and
 * the current selection — plus the undo/redo history lives here rather than in
 * React `useState`. A single Zustand store lets Timeline, Inspector and Preview
 * subscribe to only the slices they render, so a slider drag no longer re-renders
 * the whole app. The transient playhead stays in `playbackStore`, outside React.
 *
 * `useEditHistory` is a thin binding over this store and keeps its previous
 * public API, so existing `App.tsx` call sites are unchanged.
 */

/** Default coalescing window for rapid edits (inspector sliders, text fields). */
export const DEFAULT_DEBOUNCE_MS = 400;

/** Matches React's `SetStateAction<T>` so functional updaters keep working. */
export type StateUpdater<T> = T | ((prev: T) => T);

function resolveUpdater<T>(action: StateUpdater<T>, prev: T): T {
  return typeof action === 'function'
    ? (action as (prev: T) => T)(prev)
    : action;
}

export interface EditorState {
  clips: Clip[];
  tracks: Track[];
  clipGroups: ClipGroup[];
  transitions: ClipTransition[];
  textOverlays: TextOverlay[];
  selectedClipId: string | null;
  masterAudio: MasterAudio | null;
  /** Undo/redo depths, published so `canUndo`/`canRedo` re-render on change. */
  undoDepth: number;
  redoDepth: number;

  setClips: (action: StateUpdater<Clip[]>) => void;
  setTracks: (action: StateUpdater<Track[]>) => void;
  setClipGroups: (action: StateUpdater<ClipGroup[]>) => void;
  setTransitions: (action: StateUpdater<ClipTransition[]>) => void;
  setTextOverlays: (action: StateUpdater<TextOverlay[]>) => void;
  setSelectedClipId: (action: StateUpdater<string | null>) => void;
  setMasterAudio: (action: StateUpdater<MasterAudio | null>) => void;

  /** Push the current state onto the undo stack (call before a discrete edit). */
  pushHistory: () => void;
  /**
   * Coalesce rapid edits into a single undo step.
   * @param group Stable key for the editing session (e.g. `inspector:${clipId}`).
   */
  pushHistoryDebounced: (group: string, debounceMs?: number) => void;
  undo: () => void;
  redo: () => void;
  /** Replace editing state and clear undo/redo stacks (e.g. after project load). */
  resetHistory: (snapshot: EditSnapshot) => void;
}

/**
 * Transient bookkeeping kept outside the reactive state so mutating it never
 * triggers a render. Snapshot stacks hold structural clones; the maps drive
 * debounce coalescing.
 */
const undoStack: EditSnapshot[] = [];
const redoStack: EditSnapshot[] = [];
const debounceSessions = new Map<string, boolean>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let isRestoring = false;

export const editorStore = createStore<EditorState>()((set, get) => {
  const snapshotOf = (): EditSnapshot => {
    const state = get();
    return {
      clips: state.clips,
      tracks: state.tracks,
      clipGroups: state.clipGroups,
      transitions: state.transitions,
      textOverlays: state.textOverlays,
      selectedClipId: state.selectedClipId,
      masterAudio: state.masterAudio,
    };
  };

  const publishDepths = () =>
    set({ undoDepth: undoStack.length, redoDepth: redoStack.length });

  /** Restore a snapshot, reusing live object URLs and revoking orphaned ones. */
  const applySnapshot = (snapshot: EditSnapshot) => {
    isRestoring = true;
    try {
      const previousClips = get().clips;
      const mergedClips = mergeClipUrls(snapshot.clips, previousClips);
      revokeOrphanedUrls(previousClips, mergedClips);
      set({
        clips: mergedClips,
        tracks: cloneTracks(snapshot.tracks),
        clipGroups: syncClipGroups(snapshot.clipGroups, mergedClips),
        transitions: snapshot.transitions.map((transition) => ({ ...transition })),
        textOverlays: snapshot.textOverlays.map((overlay) => ({ ...overlay })),
        selectedClipId: snapshot.selectedClipId,
        masterAudio: snapshot.masterAudio
          ? { ...snapshot.masterAudio, objectUrl: snapshot.masterAudio.objectUrl }
          : null,
      });
    } finally {
      isRestoring = false;
    }
  };

  const pushHistory = () => {
    if (isRestoring) return;
    undoStack.push(cloneSnapshot(snapshotOf()));
    trimHistoryStack(undoStack);
    redoStack.length = 0;
    publishDepths();
  };

  return {
    clips: [],
    tracks: createDefaultTracks(),
    clipGroups: [],
    transitions: [],
    textOverlays: [],
    selectedClipId: null,
    masterAudio: null,
    undoDepth: 0,
    redoDepth: 0,

    setClips: (action) => set((s) => ({ clips: resolveUpdater(action, s.clips) })),
    setTracks: (action) => set((s) => ({ tracks: resolveUpdater(action, s.tracks) })),
    setClipGroups: (action) =>
      set((s) => ({ clipGroups: resolveUpdater(action, s.clipGroups) })),
    setTransitions: (action) =>
      set((s) => ({ transitions: resolveUpdater(action, s.transitions) })),
    setTextOverlays: (action) =>
      set((s) => ({ textOverlays: resolveUpdater(action, s.textOverlays) })),
    setSelectedClipId: (action) =>
      set((s) => ({ selectedClipId: resolveUpdater(action, s.selectedClipId) })),
    setMasterAudio: (action) =>
      set((s) => ({ masterAudio: resolveUpdater(action, s.masterAudio) })),

    pushHistory,

    pushHistoryDebounced: (group, debounceMs = DEFAULT_DEBOUNCE_MS) => {
      if (isRestoring) return;

      if (!debounceSessions.get(group)) {
        pushHistory();
        debounceSessions.set(group, true);
      }

      const existingTimer = debounceTimers.get(group);
      if (existingTimer) clearTimeout(existingTimer);

      debounceTimers.set(
        group,
        setTimeout(() => {
          debounceSessions.set(group, false);
          debounceTimers.delete(group);
        }, debounceMs),
      );
    },

    undo: () => {
      if (undoStack.length === 0) return;
      redoStack.push(cloneSnapshot(snapshotOf()));
      trimHistoryStack(redoStack);
      applySnapshot(undoStack.pop()!);
      publishDepths();
    },

    redo: () => {
      if (redoStack.length === 0) return;
      undoStack.push(cloneSnapshot(snapshotOf()));
      trimHistoryStack(undoStack);
      applySnapshot(redoStack.pop()!);
      publishDepths();
    },

    resetHistory: (snapshot) => {
      undoStack.length = 0;
      redoStack.length = 0;
      debounceSessions.clear();
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      applySnapshot(snapshot);
      publishDepths();
    },
  };
});

// --- Granular selector hooks -------------------------------------------------
// Components subscribe to only the slice they render, so unrelated edits do not
// re-render them (the core #144 win). `useEditHistory` remains for the App shell.

export const useEditorClips = () =>
  useStore(editorStore, useShallow((s) => s.clips));
export const useEditorTracks = () =>
  useStore(editorStore, useShallow((s) => s.tracks));
export const useEditorClipGroups = () =>
  useStore(editorStore, useShallow((s) => s.clipGroups));
export const useEditorTransitions = () =>
  useStore(editorStore, useShallow((s) => s.transitions));
export const useEditorTextOverlays = () =>
  useStore(editorStore, useShallow((s) => s.textOverlays));
export const useSelectedClipId = () => useStore(editorStore, (s) => s.selectedClipId);
export const useEditorMasterAudio = () => useStore(editorStore, (s) => s.masterAudio);

/** Clips on the timeline (active A/B variant per group, track-aware order). */
export const useEditorTimelineClips = () =>
  useStore(
    editorStore,
    useShallow((s) => getEffectiveTimelineClips(s.tracks, s.clips, s.clipGroups)),
  );

/** Per-row selection subscription — only re-renders when this clip's selected state toggles. */
export const useIsClipSelected = (clipId: string) =>
  useStore(editorStore, (s) => s.selectedClipId === clipId);

/**
 * Look up a single clip by id. Equality-stable across unrelated edits: the
 * store's `setClips` updaters replace only the touched element (`.map`), so
 * every other clip keeps its previous object reference and this selector's
 * result only changes when the looked-up clip itself changes.
 */
export const useEditorClip = (id: string | null) =>
  useStore(editorStore, (s) => (id ? (s.clips.find((c) => c.id === id) ?? null) : null));

/**
 * Stable action references. These functions are created once when the store
 * is instantiated and never replaced by `set`, so they can be imported and
 * called directly without a hook (no subscription needed).
 */
export const editorActions: Pick<
  EditorState,
  | 'setClips'
  | 'setTracks'
  | 'setClipGroups'
  | 'setTransitions'
  | 'setTextOverlays'
  | 'setSelectedClipId'
  | 'setMasterAudio'
  | 'pushHistory'
  | 'pushHistoryDebounced'
  | 'undo'
  | 'redo'
  | 'resetHistory'
> = editorStore.getState();

/** Test-only reset so specs start from a clean store and empty history. */
export function __resetEditorStoreForTests(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  debounceSessions.clear();
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  isRestoring = false;
  editorStore.setState({
    clips: [],
    tracks: createDefaultTracks(),
    clipGroups: [],
    transitions: [],
    textOverlays: [],
    selectedClipId: null,
    masterAudio: null,
    undoDepth: 0,
    redoDepth: 0,
  });
}
