import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { StateUpdater } from './editorStore';
import type { DropEditMode, TimelineEditTool } from '../utils/editModes';
import {
  DEFAULT_FINISHING_PREVIEW_VIEW,
  toggleBefore,
  type FinishingPassKey,
  type FinishingPreviewView,
} from '../utils/finishingStack';

function resolveUpdater<T>(action: StateUpdater<T>, prev: T): T {
  return typeof action === 'function' ? (action as (prev: T) => T)(prev) : action;
}

/**
 * Transient UI state that is not part of the edited document (#144).
 *
 * Selection of a text overlay and modal visibility used to live in `App.tsx`
 * `useState` and were threaded down through `AppShell` into `Preview` and
 * `TextOverlayPanel`. Keeping them here lets those panels subscribe directly,
 * so toggling a modal no longer re-renders the timeline.
 *
 * Unlike `editorStore`, nothing here is captured in undo/redo snapshots or
 * serialized into a saved project — it is view state only.
 */
export interface UiState {
  /** Text overlay currently selected in the preview / overlay panel. */
  selectedTextOverlayId: string | null;
  /** Caption cue currently selected in the caption lane / Inspector. */
  selectedCaptionId: string | null;
  /** Whether the keyboard shortcuts modal is open. */
  showKeyboardShortcuts: boolean;
  /** Sticky timeline tool — what Alt+←/→ nudges do to the selected clip. */
  timelineTool: TimelineEditTool;
  /** Whether a drop onto a lane covers (overwrite) or pushes (insert) its items. */
  dropEditMode: DropEditMode;
  /** Timeline magnet: drops snap to the playhead, clip edges, markers, captions and beats. */
  snapEnabled: boolean;
  /** Ripple every unlocked lane together instead of only the edited lane. */
  linkedRipple: boolean;
  /**
   * Effects Stack audition state: bypass the whole finishing chain, or show
   * single passes "before". Preview-only — export always applies the chain.
   */
  finishingView: FinishingPreviewView;
  /** Ask the Inspector to switch tabs (`seq` makes repeat requests distinct). */
  inspectorTabRequest: { tab: 'clip' | 'export' | 'captions'; seq: number } | null;

  /** Accepts a value or an updater, mirroring React's `SetStateAction`. */
  setSelectedTextOverlayId: (id: StateUpdater<string | null>) => void;
  setSelectedCaptionId: (id: StateUpdater<string | null>) => void;
  setShowKeyboardShortcuts: (open: StateUpdater<boolean>) => void;
  setTimelineTool: (tool: TimelineEditTool) => void;
  setDropEditMode: (mode: DropEditMode) => void;
  setSnapEnabled: (enabled: StateUpdater<boolean>) => void;
  setLinkedRipple: (linked: StateUpdater<boolean>) => void;
  setFinishingBypassAll: (bypass: boolean) => void;
  toggleFinishingBefore: (key: FinishingPassKey) => void;
  resetFinishingView: () => void;
  requestInspectorTab: (tab: 'clip' | 'export' | 'captions') => void;
}

export const uiStore = createStore<UiState>()((set) => ({
  selectedTextOverlayId: null,
  selectedCaptionId: null,
  showKeyboardShortcuts: false,
  timelineTool: 'select',
  dropEditMode: 'overwrite',
  snapEnabled: true,
  linkedRipple: false,
  finishingView: DEFAULT_FINISHING_PREVIEW_VIEW,
  inspectorTabRequest: null,

  setSelectedTextOverlayId: (id) =>
    set((s) => ({ selectedTextOverlayId: resolveUpdater(id, s.selectedTextOverlayId) })),
  setSelectedCaptionId: (id) =>
    set((s) => ({ selectedCaptionId: resolveUpdater(id, s.selectedCaptionId) })),
  setShowKeyboardShortcuts: (open) =>
    set((s) => ({ showKeyboardShortcuts: resolveUpdater(open, s.showKeyboardShortcuts) })),
  setTimelineTool: (timelineTool) => set({ timelineTool }),
  setDropEditMode: (dropEditMode) => set({ dropEditMode }),
  setSnapEnabled: (enabled) =>
    set((s) => ({ snapEnabled: resolveUpdater(enabled, s.snapEnabled) })),
  setLinkedRipple: (linked) =>
    set((s) => ({ linkedRipple: resolveUpdater(linked, s.linkedRipple) })),
  setFinishingBypassAll: (bypassAll) =>
    set((s) => ({ finishingView: { ...s.finishingView, bypassAll } })),
  toggleFinishingBefore: (key) =>
    set((s) => ({ finishingView: toggleBefore(s.finishingView, key) })),
  resetFinishingView: () => set({ finishingView: DEFAULT_FINISHING_PREVIEW_VIEW }),
  requestInspectorTab: (tab) =>
    set((s) => ({ inspectorTabRequest: { tab, seq: (s.inspectorTabRequest?.seq ?? 0) + 1 } })),
}));

/**
 * Stable action references — created once with the store and never replaced by
 * `set`, so callers can import and invoke them without subscribing.
 */
export const uiActions: Pick<
  UiState,
  | 'setSelectedTextOverlayId'
  | 'setSelectedCaptionId'
  | 'setShowKeyboardShortcuts'
  | 'setTimelineTool'
  | 'setDropEditMode'
  | 'setSnapEnabled'
  | 'setLinkedRipple'
  | 'setFinishingBypassAll'
  | 'toggleFinishingBefore'
  | 'resetFinishingView'
  | 'requestInspectorTab'
> = uiStore.getState();

export const useSelectedTextOverlayId = () =>
  useStore(uiStore, (s) => s.selectedTextOverlayId);
export const useSelectedCaptionId = () =>
  useStore(uiStore, (s) => s.selectedCaptionId);
export const useShowKeyboardShortcuts = () =>
  useStore(uiStore, (s) => s.showKeyboardShortcuts);

/** Test-only reset so specs start from a clean store. */
export function __resetUiStoreForTests(): void {
  uiStore.setState({
    selectedTextOverlayId: null,
    selectedCaptionId: null,
    showKeyboardShortcuts: false,
    timelineTool: 'select',
    dropEditMode: 'overwrite',
    snapEnabled: true,
    linkedRipple: false,
    finishingView: DEFAULT_FINISHING_PREVIEW_VIEW,
    inspectorTabRequest: null,
  });
}

export const useTimelineTool = () => useStore(uiStore, (s) => s.timelineTool);
export const useDropEditMode = () => useStore(uiStore, (s) => s.dropEditMode);
export const useSnapEnabled = () => useStore(uiStore, (s) => s.snapEnabled);
export const useLinkedRipple = () => useStore(uiStore, (s) => s.linkedRipple);
export const useFinishingView = () => useStore(uiStore, (s) => s.finishingView);
