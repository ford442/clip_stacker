import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewRenderControls } from './PreviewRenderControls';
import { previewCacheStore } from '../store/previewCacheStore';
import { renderCacheStore } from '../store/renderCacheStore';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

describe('PreviewRenderControls', () => {
  beforeEach(() => {
    previewCacheStore.getState().setInPoint(null);
    previewCacheStore.getState().setOutPoint(null);
    previewCacheStore.getState().setJob(null);
    renderCacheStore.getState().update({ previewCache: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Render In to Out"]');

  it('renders with an In → Out range marked (no update loop) and enables Render', () => {
    act(() => {
      previewCacheStore.getState().setInPoint(0.5);
      previewCacheStore.getState().setOutPoint(2.5);
    });
    // Before the fix this threw React #185 (maximum update depth exceeded).
    act(() => root.render(<PreviewRenderControls />));
    expect(renderButton()?.disabled).toBe(false);
  });

  it('disables Render without a range and shows job progress while rendering', () => {
    act(() => root.render(<PreviewRenderControls />));
    expect(renderButton()?.disabled).toBe(true);
    act(() => previewCacheStore.getState().setJob({ done: 3, total: 60 }));
    expect(container.textContent).toContain('3/60');
  });
});
