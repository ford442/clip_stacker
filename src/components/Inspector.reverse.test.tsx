import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Inspector } from './Inspector';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { createTestClip } from '../utils/project.test.helpers';
import type { Clip } from '../types';

const NOOP_CAPTIONS = {
  onAdd: () => 'new',
  onUpdate: () => undefined,
  onDelete: () => undefined,
  onStyleChange: () => undefined,
  onImport: async () => undefined,
  onExportSrt: () => undefined,
  onClear: () => undefined,
};

describe('Inspector — reverse clip', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(clip: Clip, onReverseChange = vi.fn()) {
    editorStore.getState().setClips([clip]);
    editorStore.getState().setSelectedClipId(clip.id);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <Inspector
          onChange={() => undefined}
          onReverseChange={onReverseChange}
          captions={NOOP_CAPTIONS as never}
        />,
      );
    });
    return { el: container, onReverseChange };
  }

  function toggle(el: HTMLElement): HTMLInputElement | null {
    const label = Array.from(el.querySelectorAll('label')).find((node) =>
      node.textContent?.includes('Reverse clip'),
    );
    return label?.querySelector('input[type="checkbox"]') ?? null;
  }

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.parentNode?.removeChild(container);
    container = null;
    __resetEditorStoreForTests();
  });

  it('offers the toggle for a video clip and reports it turning on', () => {
    const { el, onReverseChange } = mount(createTestClip('v', 5));
    const box = toggle(el);
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    act(() => box!.click());
    expect(onReverseChange).toHaveBeenCalledWith(true);
  });

  it('shows the toggle checked when the clip is already reversed', () => {
    const { el } = mount({ ...createTestClip('v', 5), reversed: true });
    expect(toggle(el)!.checked).toBe(true);
  });

  it('hides the toggle for a still image', () => {
    const { el } = mount({ ...createTestClip('v', 5), stillImage: true });
    expect(toggle(el)).toBeNull();
  });
});
