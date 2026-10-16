import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  clampSideWidth,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  type LayoutDensity,
  type WorkspaceLayout,
  type WorkspaceSide,
} from '../utils/workspaceLayout';

/**
 * Workspace layout state: panel widths, the upper-zone / timeline split,
 * collapsed side panels, toolbar density and full-width mode.
 *
 * Like `uiStore` this is view state — never in undo history or a saved
 * project — but unlike it, it survives a reload (localStorage, per browser).
 * The shell applies it as CSS variables from a store subscription, so a
 * splitter drag never re-renders the panels themselves.
 */
export interface LayoutState extends WorkspaceLayout {
  setSideWidth: (side: WorkspaceSide, width: number) => void;
  setSideCollapsed: (side: WorkspaceSide, collapsed: boolean) => void;
  toggleSideCollapsed: (side: WorkspaceSide) => void;
  setVerticalSplit: (upperHeight: number | null, timelineHeight: number | null) => void;
  setDensity: (density: LayoutDensity) => void;
  setFullWidth: (fullWidth: boolean) => void;
  /** Restore one side column to its default width (splitter double-click). */
  resetSideWidth: (side: WorkspaceSide) => void;
  /** Back to natural heights (divider double-click). */
  resetVerticalSplit: () => void;
  /** Everything back to defaults ("Reset layout"). */
  resetLayout: () => void;
}

const widthKey = (side: WorkspaceSide) =>
  side === 'library' ? 'libraryWidth' : 'inspectorWidth';
const collapsedKey = (side: WorkspaceSide) =>
  side === 'library' ? 'libraryCollapsed' : 'inspectorCollapsed';

export const layoutStore = createStore<LayoutState>()((set) => ({
  ...loadWorkspaceLayout(),

  setSideWidth: (side, width) => set({ [widthKey(side)]: clampSideWidth(side, width) }),
  setSideCollapsed: (side, collapsed) => set({ [collapsedKey(side)]: collapsed }),
  toggleSideCollapsed: (side) =>
    set((s) => ({ [collapsedKey(side)]: !s[collapsedKey(side)] })),
  setVerticalSplit: (upperHeight, timelineHeight) => set({ upperHeight, timelineHeight }),
  setDensity: (density) => set({ density }),
  setFullWidth: (fullWidth) => set({ fullWidth }),
  resetSideWidth: (side) =>
    set({ [widthKey(side)]: DEFAULT_WORKSPACE_LAYOUT[widthKey(side)] }),
  resetVerticalSplit: () => set({ upperHeight: null, timelineHeight: null }),
  resetLayout: () => set({ ...DEFAULT_WORKSPACE_LAYOUT }),
}));

export function selectWorkspaceLayout(s: LayoutState): WorkspaceLayout {
  return {
    libraryWidth: s.libraryWidth,
    inspectorWidth: s.inspectorWidth,
    libraryCollapsed: s.libraryCollapsed,
    inspectorCollapsed: s.inspectorCollapsed,
    upperHeight: s.upperHeight,
    timelineHeight: s.timelineHeight,
    density: s.density,
    fullWidth: s.fullWidth,
  };
}

/** Writes are coalesced so a splitter drag stores once, after it settles. */
export const LAYOUT_PERSIST_DELAY_MS = 250;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function flushLayoutPersistence(): void {
  if (persistTimer === null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  saveWorkspaceLayout(selectWorkspaceLayout(layoutStore.getState()));
}

layoutStore.subscribe(() => {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveWorkspaceLayout(selectWorkspaceLayout(layoutStore.getState()));
  }, LAYOUT_PERSIST_DELAY_MS);
});

if (typeof window !== 'undefined') {
  // A reload straight after a drag must not lose the last size.
  window.addEventListener('pagehide', flushLayoutPersistence);
}

/** Stable action references (never replaced by `set`). */
export const layoutActions: Pick<
  LayoutState,
  | 'setSideWidth'
  | 'setSideCollapsed'
  | 'toggleSideCollapsed'
  | 'setVerticalSplit'
  | 'setDensity'
  | 'setFullWidth'
  | 'resetSideWidth'
  | 'resetVerticalSplit'
  | 'resetLayout'
> = layoutStore.getState();

export const useLayoutDensity = () => useStore(layoutStore, (s) => s.density);
export const useLayoutFullWidth = () => useStore(layoutStore, (s) => s.fullWidth);
export const useSideWidth = (side: WorkspaceSide) =>
  useStore(layoutStore, (s) => s[widthKey(side)]);
export const useSideCollapsed = (side: WorkspaceSide) =>
  useStore(layoutStore, (s) => s[collapsedKey(side)]);
export const useUpperHeight = () => useStore(layoutStore, (s) => s.upperHeight);

/** Test-only reset so specs start from defaults (and nothing pending to persist). */
export function __resetLayoutStoreForTests(): void {
  layoutStore.setState({ ...DEFAULT_WORKSPACE_LAYOUT });
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = null;
}
