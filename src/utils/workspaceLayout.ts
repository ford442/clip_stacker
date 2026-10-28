/**
 * Workspace layout (the Cubase-style resizable zones).
 *
 * Pure model + maths for the Library | Preview | Inspector columns and the
 * split between that upper zone and the timeline. No DOM, no React — the
 * splitters measure, call these, and `layoutStore` holds the result.
 *
 * Persisted per browser in localStorage. It is view state: never part of a
 * saved project or undo history.
 */

import { clamp } from './math';

export type LayoutDensity = 'compact' | 'comfortable' | 'spacious';
export type WorkspaceSide = 'library' | 'inspector';

export interface WorkspaceLayout {
  /** Library column width in CSS px (when expanded). */
  libraryWidth: number;
  /** Inspector column width in CSS px (when expanded). */
  inspectorWidth: number;
  libraryCollapsed: boolean;
  inspectorCollapsed: boolean;
  /**
   * Height of the Library | Preview | Inspector zone. `null` = the default,
   * fitted to the window in CSS (layout.css). Either way the side panels
   * scroll inside the zone and the preview is capped to fit it.
   */
  upperHeight: number | null;
  /** Height of the timeline's scroll area. `null` = grows with its lanes. */
  timelineHeight: number | null;
  density: LayoutDensity;
  /** Fill the window instead of centring at {@link CENTERED_SHELL_MAX_WIDTH}. */
  fullWidth: boolean;
}

export const CENTERED_SHELL_MAX_WIDTH = 1440;

export const WORKSPACE_LIMITS = {
  libraryMin: 200,
  libraryMax: 640,
  inspectorMin: 220,
  inspectorMax: 720,
  /** The preview column never gets narrower than this while dragging a side. */
  previewMin: 320,
  /** Width of each column splitter track — the grid gap (layout.css `--ws-gap`). */
  splitterSize: 16,
  upperMin: 240,
  upperMax: 4000,
  timelineMin: 120,
  timelineMax: 4000,
} as const;

/** Keyboard step for a focused splitter; Shift multiplies it. */
export const SPLITTER_KEY_STEP_PX = 16;
export const SPLITTER_KEY_STEP_LARGE_PX = 64;

export const DEFAULT_WORKSPACE_LAYOUT: Readonly<WorkspaceLayout> = Object.freeze({
  libraryWidth: 260,
  inspectorWidth: 280,
  libraryCollapsed: false,
  inspectorCollapsed: false,
  upperHeight: null,
  timelineHeight: null,
  density: 'comfortable',
  fullWidth: true,
});

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'clip_stacker.workspaceLayout.v1';

const DENSITIES: readonly LayoutDensity[] = ['compact', 'comfortable', 'spacious'];

export function isLayoutDensity(value: unknown): value is LayoutDensity {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

export function sideLimits(side: WorkspaceSide): { min: number; max: number } {
  return side === 'library'
    ? { min: WORKSPACE_LIMITS.libraryMin, max: WORKSPACE_LIMITS.libraryMax }
    : { min: WORKSPACE_LIMITS.inspectorMin, max: WORKSPACE_LIMITS.inspectorMax };
}

/**
 * Clamp a side column to its own limits and, when the grid width is known,
 * to whatever leaves the preview its minimum next to the other side.
 *
 * `otherWidth` is the width the opposite column actually occupies (0 when it
 * is collapsed to its rail is close enough — the rail is narrow).
 */
export function clampSideWidth(
  side: WorkspaceSide,
  width: number,
  context: { gridWidth?: number; otherWidth?: number } = {},
): number {
  const { min, max } = sideLimits(side);
  let upper: number = max;
  const { gridWidth, otherWidth = 0 } = context;
  if (gridWidth !== undefined && Number.isFinite(gridWidth) && gridWidth > 0) {
    const room =
      gridWidth - otherWidth - WORKSPACE_LIMITS.previewMin - 2 * WORKSPACE_LIMITS.splitterSize;
    upper = Math.min(upper, room);
  }
  // A cramped window can leave less room than the minimum; the minimum wins
  // (CSS caps each side at a share of the grid, so nothing overflows).
  return Math.round(clamp(width, min, Math.max(min, upper)));
}

/**
 * Width of a side column after dragging its splitter `deltaPx` to the right.
 * The library's splitter is on its right edge (drag right = wider); the
 * inspector's is on its left edge (drag right = narrower).
 */
export function resizeSideByDrag(
  side: WorkspaceSide,
  startWidth: number,
  deltaPx: number,
  context: { gridWidth?: number; otherWidth?: number } = {},
): number {
  const signed = side === 'library' ? deltaPx : -deltaPx;
  return clampSideWidth(side, startWidth + signed, context);
}

export interface VerticalSplit {
  upperHeight: number;
  timelineHeight: number | null;
}

/**
 * Move the divider between the upper zone and the timeline by `deltaPx`
 * (positive = down). When the timeline height is known the two trade space,
 * so their sum — and therefore everything below the timeline — stays put
 * while the divider follows the pointer. Without a timeline (no clips yet)
 * only the upper zone changes.
 */
export function resizeVerticalSplit(
  start: { upperHeight: number; timelineHeight: number | null },
  deltaPx: number,
): VerticalSplit {
  const { upperMin, upperMax, timelineMin, timelineMax } = WORKSPACE_LIMITS;
  if (start.timelineHeight === null) {
    return {
      upperHeight: Math.round(clamp(start.upperHeight + deltaPx, upperMin, upperMax)),
      timelineHeight: null,
    };
  }
  const total = start.upperHeight + start.timelineHeight;
  // Both sides must stay within their limits, so the delta range is the
  // intersection of what each allows.
  const minDelta = Math.max(upperMin - start.upperHeight, start.timelineHeight - timelineMax);
  const maxDelta = Math.min(upperMax - start.upperHeight, start.timelineHeight - timelineMin);
  const delta = minDelta > maxDelta ? 0 : clamp(deltaPx, minDelta, maxDelta);
  const upperHeight = Math.round(start.upperHeight + delta);
  return { upperHeight, timelineHeight: Math.round(total - upperHeight) };
}

export type SplitterKeyAction =
  | { kind: 'step'; deltaPx: number }
  | { kind: 'min' }
  | { kind: 'max' }
  | { kind: 'toggle' };

/**
 * Keyboard handling for a focused splitter (WAI-ARIA window splitter
 * pattern). Deltas are in the same "+ = right / down" axis as pointer drags.
 * `orientation` is the separator's: `vertical` sits between columns.
 */
export function splitterKeyAction(
  key: string,
  shiftKey: boolean,
  orientation: 'vertical' | 'horizontal',
): SplitterKeyAction | null {
  const step = shiftKey ? SPLITTER_KEY_STEP_LARGE_PX : SPLITTER_KEY_STEP_PX;
  if (orientation === 'vertical') {
    if (key === 'ArrowLeft') return { kind: 'step', deltaPx: -step };
    if (key === 'ArrowRight') return { kind: 'step', deltaPx: step };
  } else {
    if (key === 'ArrowUp') return { kind: 'step', deltaPx: -step };
    if (key === 'ArrowDown') return { kind: 'step', deltaPx: step };
  }
  if (key === 'Home') return { kind: 'min' };
  if (key === 'End') return { kind: 'max' };
  if (key === 'Enter') return { kind: 'toggle' };
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalHeight(value: unknown, min: number, max: number): number | null {
  const n = finiteNumber(value);
  return n === undefined ? null : Math.round(clamp(n, min, max));
}

/**
 * Coerce whatever came out of storage into a valid layout. Unknown or
 * malformed fields fall back to the default rather than throwing, so a bad
 * or older payload can never break the shell.
 */
export function sanitizeWorkspaceLayout(raw: unknown): WorkspaceLayout {
  const d = DEFAULT_WORKSPACE_LAYOUT;
  if (!raw || typeof raw !== 'object') return { ...d };
  const r = raw as Record<string, unknown>;
  const libraryWidth = finiteNumber(r.libraryWidth);
  const inspectorWidth = finiteNumber(r.inspectorWidth);
  return {
    libraryWidth:
      libraryWidth === undefined ? d.libraryWidth : clampSideWidth('library', libraryWidth),
    inspectorWidth:
      inspectorWidth === undefined
        ? d.inspectorWidth
        : clampSideWidth('inspector', inspectorWidth),
    libraryCollapsed:
      typeof r.libraryCollapsed === 'boolean' ? r.libraryCollapsed : d.libraryCollapsed,
    inspectorCollapsed:
      typeof r.inspectorCollapsed === 'boolean' ? r.inspectorCollapsed : d.inspectorCollapsed,
    upperHeight: optionalHeight(r.upperHeight, WORKSPACE_LIMITS.upperMin, WORKSPACE_LIMITS.upperMax),
    timelineHeight: optionalHeight(
      r.timelineHeight,
      WORKSPACE_LIMITS.timelineMin,
      WORKSPACE_LIMITS.timelineMax,
    ),
    density: isLayoutDensity(r.density) ? r.density : d.density,
    fullWidth: typeof r.fullWidth === 'boolean' ? r.fullWidth : d.fullWidth,
  };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Accessing localStorage throws with blocked site data.
    return null;
  }
}

export function loadWorkspaceLayout(
  storage: StorageLike | null = defaultStorage(),
): WorkspaceLayout {
  if (!storage) return { ...DEFAULT_WORKSPACE_LAYOUT };
  try {
    const raw = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return sanitizeWorkspaceLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

/** Best effort: a full or blocked storage just means the layout is not remembered. */
export function saveWorkspaceLayout(
  layout: WorkspaceLayout,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Quota / privacy mode — ignore.
  }
}

/**
 * CSS custom properties and data attributes the shell carries. Heights that
 * are `null` produce no variable at all, so the stylesheet's natural-height
 * rules apply.
 */
export function workspaceShellAttributes(layout: WorkspaceLayout): {
  vars: Record<string, string | null>;
  data: Record<string, string | null>;
} {
  return {
    vars: {
      '--ws-library-width': `${layout.libraryWidth}px`,
      '--ws-inspector-width': `${layout.inspectorWidth}px`,
      '--ws-upper-height': layout.upperHeight === null ? null : `${layout.upperHeight}px`,
      '--ws-timeline-height': layout.timelineHeight === null ? null : `${layout.timelineHeight}px`,
    },
    data: {
      'data-density': layout.density,
      'data-library-collapsed': layout.libraryCollapsed ? 'true' : null,
      'data-inspector-collapsed': layout.inspectorCollapsed ? 'true' : null,
      'data-timeline-fixed': layout.timelineHeight === null ? null : 'true',
      'data-full-width': layout.fullWidth ? 'true' : null,
    },
  };
}
