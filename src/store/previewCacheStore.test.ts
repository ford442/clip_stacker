import { describe, expect, it } from 'vitest';
import { markedRange, previewCacheStore } from './previewCacheStore';
import { sanitizeRenderCacheSettings, DEFAULT_RENDER_CACHE_SETTINGS } from './renderCacheStore';

describe('previewCacheStore', () => {
  it('orders the marks and needs both for a range', () => {
    expect(markedRange({ inPoint: null, outPoint: 3 })).toBeNull();
    expect(markedRange({ inPoint: 4, outPoint: 1 })).toEqual([1, 4]);
    expect(markedRange({ inPoint: 2, outPoint: 2 })).toBeNull();
  });

  it('keeps cached ranges by value and bumps requests', () => {
    const store = previewCacheStore.getState();
    store.setCachedRanges([[0, 10]]);
    const first = previewCacheStore.getState().cachedRanges;
    store.setCachedRanges([[0, 10]]);
    expect(previewCacheStore.getState().cachedRanges).toBe(first);
    const before = previewCacheStore.getState().renderRequest;
    store.requestRender();
    expect(previewCacheStore.getState().renderRequest).toBe(before + 1);
    store.requestClear();
    expect(previewCacheStore.getState().cachedRanges).toEqual([]);
    store.setInPoint(-3);
    expect(previewCacheStore.getState().inPoint).toBe(0);
    store.clearMarks();
    expect(previewCacheStore.getState().inPoint).toBeNull();
  });
});

describe('render cache settings', () => {
  it('fall back field by field', () => {
    expect(sanitizeRenderCacheSettings(null)).toEqual(DEFAULT_RENDER_CACHE_SETTINGS);
    expect(sanitizeRenderCacheSettings({ enabled: false, budgetBytes: 12, backgroundRender: 'yes' })).toEqual({
      ...DEFAULT_RENDER_CACHE_SETTINGS,
      enabled: false,
    });
    expect(sanitizeRenderCacheSettings({ budgetBytes: 1e15 }).budgetBytes).toBe(64 * 1024 ** 3);
  });
});
