import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { StateUpdater } from './editorStore';

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

  /** Accepts a value or an updater, mirroring React's `SetStateAction`. */
  setSelectedTextOverlayId: (id: StateUpdater<string | null>) => void;
  setSelectedCaptionId: (id: StateUpdater<string | null>) => void;
  setShowKeyboardShortcuts: (open: StateUpdater<boolean>) => void;
}

export const uiStore = createStore<UiState>()((set) => ({
  selectedTextOverlayId: null,
  selectedCaptionId: null,
  showKeyboardShortcuts: false,

  setSelectedTextOverlayId: (id) =>
    set((s) => ({ selectedTextOverlayId: resolveUpdater(id, s.selectedTextOverlayId) })),
  setSelectedCaptionId: (id) =>
    set((s) => ({ selectedCaptionId: resolveUpdater(id, s.selectedCaptionId) })),
  setShowKeyboardShortcuts: (open) =>
    set((s) => ({ showKeyboardShortcuts: resolveUpdater(open, s.showKeyboardShortcuts) })),
}));

/**
 * Stable action references — created once with the store and never replaced by
 * `set`, so callers can import and invoke them without subscribing.
 */
export const uiActions: Pick<
  UiState,
  'setSelectedTextOverlayId' | 'setSelectedCaptionId' | 'setShowKeyboardShortcuts'
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
  });
}
