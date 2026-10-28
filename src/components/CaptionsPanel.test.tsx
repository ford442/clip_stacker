import { afterEach, describe, expect, it } from 'vitest';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { CaptionsPanel } from './CaptionsPanel';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { uiStore, __resetUiStoreForTests } from '../store/uiStore';
import { settingsStore } from '../store/settingsStore';
import type { CaptionEntry } from '../types';

const CAPTIONS: CaptionEntry[] = [
  { id: 'a', startSec: 1, endSec: 2, text: 'Hello' },
  { id: 'b', startSec: 3, endSec: 4, text: 'World' },
];

describe('CaptionsPanel', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(overrides: Partial<React.ComponentProps<typeof CaptionsPanel>> = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <StrictMode>
          <CaptionsPanel
            onAdd={() => 'new'}
            onUpdate={() => undefined}
            onDelete={() => undefined}
            onStyleChange={() => undefined}
            onImport={async () => undefined}
            onExportSrt={() => undefined}
            onClear={() => undefined}
            {...overrides}
          />
        </StrictMode>,
      );
    });
    return container;
  }

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.parentNode?.removeChild(container);
    container = null;
    __resetEditorStoreForTests();
    __resetUiStoreForTests();
    settingsStore.getState().setCaptionExportMode('none');
  });

  it('prompts for a first caption when the track is empty', () => {
    const el = mount();
    expect(el.textContent).toContain('No captions yet');
    expect(el.querySelectorAll('.captions-list-item')).toHaveLength(0);
  });

  it('disables the export and clear actions with an empty track', () => {
    const el = mount();
    const disabled = Array.from(el.querySelectorAll<HTMLButtonElement>('button'))
      .filter((b) => b.disabled)
      .map((b) => b.textContent);
    expect(disabled).toContain('Export .srt');
    expect(disabled).toContain('Clear all');
  });

  it('lists every cue with its SubRip timings', () => {
    editorStore.getState().setCaptions(CAPTIONS);
    const el = mount();
    const items = el.querySelectorAll('.captions-list-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('00:00:01,000');
    expect(items[0].textContent).toContain('00:00:02,000');
    expect(items[0].textContent).toContain('Hello');
  });

  it('expands an editor for the selected cue only', () => {
    editorStore.getState().setCaptions(CAPTIONS);
    uiStore.getState().setSelectedCaptionId('b');
    const el = mount();
    expect(el.querySelectorAll('.captions-editor')).toHaveLength(1);
    expect(el.querySelector('textarea')?.value).toBe('World');
  });

  it('shows the resolved style, with per-cue overrides winning', () => {
    editorStore.getState().setCaptions([
      { id: 'big', startSec: 0, endSec: 1, text: 'Big', style: { fontsize: 88 } },
    ]);
    editorStore.getState().setCaptionStyle({ fontsize: 44 });
    uiStore.getState().setSelectedCaptionId('big');
    const el = mount();
    expect(el.textContent).toContain('Size (88px)');
  });

  it('falls back to the project style when no cue is selected', () => {
    editorStore.getState().setCaptionStyle({ fontsize: 44 });
    const el = mount();
    expect(el.textContent).toContain('Size (44px)');
  });

  it('explains the selected export mode', () => {
    settingsStore.getState().setCaptionExportMode('soft');
    const el = mount();
    expect(el.textContent).toContain('mov_text');
    const selects = Array.from(el.querySelectorAll<HTMLSelectElement>('select'));
    const modeSelect = selects[selects.length - 1];
    expect(modeSelect.value).toBe('soft');
    expect(el.textContent).toContain('Soft subtitle track');
  });
});
