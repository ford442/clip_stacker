import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAYOUT_PERSIST_DELAY_MS,
  __resetLayoutStoreForTests,
  flushLayoutPersistence,
  layoutActions,
  layoutStore,
} from './layoutStore';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  WORKSPACE_LIMITS,
} from '../utils/workspaceLayout';

describe('layoutStore', () => {
  beforeEach(() => {
    __resetLayoutStoreForTests();
    localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts from the default layout', () => {
    const s = layoutStore.getState();
    expect(s.libraryWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.libraryWidth);
    expect(s.upperHeight).toBeNull();
    expect(s.density).toBe('comfortable');
  });

  it('clamps side widths to their limits', () => {
    layoutActions.setSideWidth('library', 10);
    expect(layoutStore.getState().libraryWidth).toBe(WORKSPACE_LIMITS.libraryMin);
    layoutActions.setSideWidth('inspector', 9999);
    expect(layoutStore.getState().inspectorWidth).toBe(WORKSPACE_LIMITS.inspectorMax);
  });

  it('collapses and restores a side without losing its width', () => {
    layoutActions.setSideWidth('library', 320);
    layoutActions.toggleSideCollapsed('library');
    expect(layoutStore.getState().libraryCollapsed).toBe(true);
    layoutActions.toggleSideCollapsed('library');
    expect(layoutStore.getState()).toMatchObject({ libraryCollapsed: false, libraryWidth: 320 });
  });

  it('resets one splitter, or everything', () => {
    layoutActions.setSideWidth('inspector', 400);
    layoutActions.setVerticalSplit(500, 200);
    layoutActions.setDensity('spacious');

    layoutActions.resetSideWidth('inspector');
    expect(layoutStore.getState().inspectorWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.inspectorWidth);

    layoutActions.resetVerticalSplit();
    expect(layoutStore.getState()).toMatchObject({ upperHeight: null, timelineHeight: null });
    expect(layoutStore.getState().density).toBe('spacious');

    layoutActions.resetLayout();
    expect(layoutStore.getState().density).toBe('comfortable');
  });

  it('persists after changes settle, once per burst', () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      layoutActions.setSideWidth('library', 300);
      layoutActions.setSideWidth('library', 310);
      layoutActions.setSideWidth('library', 320);
      expect(setItem).not.toHaveBeenCalledWith(WORKSPACE_LAYOUT_STORAGE_KEY, expect.anything());

      vi.advanceTimersByTime(LAYOUT_PERSIST_DELAY_MS);
      const writes = setItem.mock.calls.filter(([key]) => key === WORKSPACE_LAYOUT_STORAGE_KEY);
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0][1] as string).libraryWidth).toBe(320);
    } finally {
      setItem.mockRestore();
    }
  });

  it('flushes a pending write immediately (page hide)', () => {
    vi.useFakeTimers();
    layoutActions.setDensity('compact');
    flushLayoutPersistence();
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? '{}');
    expect(stored.density).toBe('compact');
  });
});
