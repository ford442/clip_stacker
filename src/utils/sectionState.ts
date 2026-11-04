/**
 * Open / closed state of collapsible Inspector sections, remembered per
 * browser in localStorage. View state like the workspace layout: never part of
 * a project or undo history.
 */

import { STORAGE_KEYS, safeGet, safeSet, storageArea, type StorageLike } from './storageKeys';

export const SECTION_STATE_STORAGE_KEY = STORAGE_KEYS.inspectorSections.key;

/** Section id → open. A missing id means "use the section's default". */
export type SectionState = Record<string, boolean>;

function defaultStorage(): StorageLike | null {
  return storageArea('local');
}

/** Keep only boolean entries; anything else in storage is ignored. */
export function sanitizeSectionState(raw: unknown): SectionState {
  const out: SectionState = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [id, open] of Object.entries(raw)) {
    if (typeof open === 'boolean') out[id] = open;
  }
  return out;
}

export function loadSectionState(storage: StorageLike | null = defaultStorage()): SectionState {
  if (!storage) return {};
  try {
    const raw = safeGet('inspectorSections', { storage });
    return raw ? sanitizeSectionState(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function isSectionOpen(id: string, defaultOpen: boolean, state: SectionState): boolean {
  return state[id] ?? defaultOpen;
}

/** Best effort: a full or blocked storage just means the choice is not remembered. */
export function saveSectionOpen(
  id: string,
  open: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  safeSet('inspectorSections', JSON.stringify({ ...loadSectionState(storage), [id]: open }), {
    storage,
  });
}

type RevealListener = (id: string) => void;
const revealListeners = new Set<RevealListener>();
const pendingReveals = new Set<string>();

/**
 * Ask a section (possibly not mounted yet — the Export tab loads lazily) to
 * open and scroll into view. Remembered as open, so a late mount starts open.
 */
export function revealSection(id: string): void {
  saveSectionOpen(id, true);
  pendingReveals.add(id);
  revealListeners.forEach((listener) => listener(id));
}

export function subscribeSectionReveal(listener: RevealListener): () => void {
  revealListeners.add(listener);
  return () => void revealListeners.delete(listener);
}

/** True once per reveal request; mounting sections call it to consume theirs. */
export function consumePendingReveal(id: string): boolean {
  return pendingReveals.delete(id);
}
