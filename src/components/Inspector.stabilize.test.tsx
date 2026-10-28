import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Inspector } from './Inspector';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { createTestClip } from '../utils/project.test.helpers';
import type { Clip, ClipStabilization } from '../types';

const STABILIZATION: ClipStabilization = {
  fps: 24,
  matrices: new Float32Array([1, 0, 0.02, 0, 1, 0.01]),
  frameCount: 1,
  zoom: 1.08,
  maxCorrection: 0.031,
  smoothRadius: 24,
};

const NOOP_CAPTIONS = {
  onAdd: () => 'new',
  onUpdate: () => undefined,
  onDelete: () => undefined,
  onStyleChange: () => undefined,
  onImport: async () => undefined,
  onExportSrt: () => undefined,
  onClear: () => undefined,
};

describe('Inspector — stabilize toggle', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(clip: Clip, onStabilizeChange = vi.fn()) {
    editorStore.getState().setClips([clip]);
    editorStore.getState().setSelectedClipId(clip.id);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <Inspector
          onChange={() => undefined}
          onStabilizeChange={onStabilizeChange}
          captions={NOOP_CAPTIONS as never}
        />,
      );
    });
    return { el: container, onStabilizeChange };
  }

  function toggle(el: HTMLElement): HTMLInputElement | null {
    const label = Array.from(el.querySelectorAll('label')).find((l) =>
      l.textContent?.includes('Stabilize this clip'),
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

  it('offers the toggle for a video clip, unchecked by default', () => {
    const { el } = mount(createTestClip('v', 5));
    const box = toggle(el);
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
  });

  it('hides the toggle for audio clips', () => {
    const { el } = mount({ ...createTestClip('a', 5), kind: 'audio' });
    expect(toggle(el)).toBeNull();
  });

  it('reports the toggle turning on and off', () => {
    const { el, onStabilizeChange } = mount(createTestClip('v', 5));
    act(() => toggle(el)!.click());
    expect(onStabilizeChange).toHaveBeenCalledWith(true);

    act(() => root!.unmount());
    root = null;
    container?.parentNode?.removeChild(container);

    const second = mount({ ...createTestClip('v', 5), stabilize: true });
    expect(toggle(second.el)!.checked).toBe(true);
    act(() => toggle(second.el)!.click());
    expect(second.onStabilizeChange).toHaveBeenCalledWith(false);
  });

  it('shows analysis progress, then the result', () => {
    const pending = mount({ ...createTestClip('v', 5), stabilize: true });
    expect(pending.el.textContent).toContain('Analysing camera motion…');

    act(() => root!.unmount());
    root = null;
    container?.parentNode?.removeChild(container);

    const done = mount({
      ...createTestClip('v', 5),
      stabilize: true,
      stabilization: STABILIZATION,
    });
    expect(done.el.textContent).toContain('3.1% peak shake corrected');
    expect(done.el.textContent).toContain('8.0% crop');
  });

  it('surfaces the reason when analysis could not run', () => {
    const { el } = mount({
      ...createTestClip('v', 5),
      stabilize: true,
      stabilizeError: 'VideoDecoder API not available',
    });
    expect(el.textContent).toContain('Stabilization unavailable — VideoDecoder API not available');
  });
});
