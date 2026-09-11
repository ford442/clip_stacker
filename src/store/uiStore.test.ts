import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetUiStoreForTests, uiActions, uiStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it('starts with nothing selected and modals closed', () => {
    expect(uiStore.getState().selectedTextOverlayId).toBeNull();
    expect(uiStore.getState().showKeyboardShortcuts).toBe(false);
  });

  it('stores and clears the selected text overlay', () => {
    uiActions.setSelectedTextOverlayId('overlay-1');
    expect(uiStore.getState().selectedTextOverlayId).toBe('overlay-1');

    uiActions.setSelectedTextOverlayId(null);
    expect(uiStore.getState().selectedTextOverlayId).toBeNull();
  });

  it('accepts functional updaters like React setState', () => {
    uiActions.setSelectedTextOverlayId('overlay-1');
    uiActions.setSelectedTextOverlayId((prev) => (prev === 'overlay-1' ? 'overlay-2' : null));
    expect(uiStore.getState().selectedTextOverlayId).toBe('overlay-2');

    uiActions.setShowKeyboardShortcuts((prev) => !prev);
    expect(uiStore.getState().showKeyboardShortcuts).toBe(true);
  });

  it('toggles the keyboard shortcuts modal', () => {
    uiActions.setShowKeyboardShortcuts(true);
    expect(uiStore.getState().showKeyboardShortcuts).toBe(true);

    uiActions.setShowKeyboardShortcuts(false);
    expect(uiStore.getState().showKeyboardShortcuts).toBe(false);
  });

  it('notifies subscribers on change', () => {
    const listener = vi.fn();
    const unsubscribe = uiStore.subscribe(listener);

    uiActions.setSelectedTextOverlayId('overlay-1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('exposes stable action references', () => {
    const before = uiStore.getState().setSelectedTextOverlayId;
    uiActions.setShowKeyboardShortcuts(true);
    expect(uiStore.getState().setSelectedTextOverlayId).toBe(before);
  });
});
