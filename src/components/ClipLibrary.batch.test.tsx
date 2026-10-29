import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClipLibrary } from './ClipLibrary';
import { editorStore, __resetEditorStoreForTests } from '../store/editorStore';
import { settingsStore } from '../store/settingsStore';
import { createTestClip } from '../utils/project.test.helpers';
import type { BatchProcessingOptions } from '../utils/batchClipProcessing';
import type { ClipGroup } from '../types';

vi.mock('./AutoCutPanel', () => ({ AutoCutPanel: () => null }));
vi.mock('./ProxyBadge', () => ({
  ProxyBadge: () => null,
  ProxyPlaybackToggle: () => null,
}));

describe('ClipLibrary batch processing', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(onBatchProcess: (ids: string[], options: BatchProcessingOptions) => Promise<boolean>) {
    editorStore.setState({
      clips: [createTestClip('alpha', 5), createTestClip('bravo', 5)],
      clipGroups: [] as ClipGroup[],
    });
    settingsStore.setState({
      intercutProcessing: false,
      isRendering: false,
      rifeProcessingClipId: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <ClipLibrary
          onToggleVariant={() => undefined}
          onDelete={() => undefined}
          onGenerateIntercut={async () => true}
          onBatchProcess={onBatchProcess}
        />,
      );
    });
    return container;
  }

  function setSelect(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    __resetEditorStoreForTests();
    settingsStore.setState({
      intercutProcessing: false,
      isRendering: false,
      rifeProcessingClipId: null,
    });
    vi.restoreAllMocks();
  });

  it('sends a multi-clip selection to RIFE with the chosen output format', async () => {
    const process = vi.fn(async () => true);
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const element = mount(process);
    const open = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Batch process clips'),
    );
    act(() => open!.click());
    const selectAll = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Select all videos'),
    );
    act(() => selectAll!.click());
    const format = Array.from(element.querySelectorAll('select')).find((select) =>
      select.closest('label')?.textContent?.includes('Output format'),
    );
    act(() => setSelect(format!, 'prores'));
    const send = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Send 2 to RIFE'),
    );
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send!.click();
    });
    expect(process).toHaveBeenCalledWith(
      ['alpha', 'bravo'],
      expect.objectContaining({
        backend: 'hf-rife',
        multiplier: 2,
        outputFormat: 'prores',
        lightVideoCleanup: false,
        audioCleanup: false,
      }),
    );
    expect(element.textContent).toContain('Download batch results (2)');
    const download = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Download batch results'),
    );
    act(() => download!.click());
    expect(downloadClick).toHaveBeenCalledTimes(2);
  });

  it('runs independent cleanup options through Browser FFmpeg', async () => {
    const process = vi.fn(async () => true);
    const element = mount(process);
    const open = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Batch process clips'),
    );
    act(() => open!.click());
    const selectAll = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Select all videos'),
    );
    act(() => selectAll!.click());
    const backend = Array.from(element.querySelectorAll('select')).find((select) =>
      select.closest('label')?.textContent?.includes('Processing'),
    );
    act(() => setSelect(backend!, 'browser-ffmpeg'));
    const audio = Array.from(element.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('Audio cleanup'),
    )?.querySelector('input');
    act(() => audio!.click());
    const processButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Process 2 with FFmpeg'),
    );
    expect(processButton?.disabled).toBe(false);
    await act(async () => {
      processButton!.click();
    });
    expect(process).toHaveBeenCalledWith(
      ['alpha', 'bravo'],
      expect.objectContaining({
        backend: 'browser-ffmpeg',
        lightVideoCleanup: false,
        audioCleanup: true,
        outputFormat: 'mp4',
      }),
    );
  });
});
