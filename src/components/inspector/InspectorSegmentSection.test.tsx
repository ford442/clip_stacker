import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { Clip } from '../../types';

// Only the edges are faked: the FFmpeg cut, reading media metadata, and fetch.
// Routing, the workflow store, replace planning and the editor store are real.
const cut = vi.hoisted(() => vi.fn());
vi.mock('../../ffmpeg/segment', () => ({ cutSegmentWithFfmpeg: cut }));
const mediaInfo = vi.hoisted(() => vi.fn());
vi.mock('../../utils/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/media')>()),
  getMediaInfo: mediaInfo,
}));

import { InspectorSegmentSection, segmentRangeProblem } from './InspectorSegmentSection';
import { editorStore, __resetEditorStoreForTests } from '../../store/editorStore';
import { segmentActions } from '../../store/segmentStore';
import { projectStore } from '../../store/projectStore';
import { createTestClip } from '../../utils/project.test.helpers';

const clipOf = (overrides: Partial<Clip> = {}): Clip => ({
  ...createTestClip('c1', 10),
  file: new File(['video'], 'c1.mp4', { type: 'video/mp4' }),
  trimStart: 2,
  trimEnd: 6,
  ...overrides,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(clip: Clip) {
  editorStore.getState().addClip(clip); // placed on the main lane like an import
  editorStore.getState().setSelectedClipId(clip.id);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<InspectorSegmentSection clip={clip} />));
  return container;
}

const button = (label: string) =>
  Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

async function click(label: string) {
  const b = button(label);
  expect(b, `button “${label}”`).toBeDefined();
  await act(async () => {
    b!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  if (!check()) throw new Error(`condition not met; panel text: ${container?.textContent}`);
}

beforeEach(() => {
  cut.mockReset().mockResolvedValue(new Blob(['cut'], { type: 'video/mp4' }));
  // Every probe/replace read reports a 4s segment (the 2–6s window).
  mediaInfo.mockReset().mockImplementation(async () => ({
    duration: 4, objectUrl: 'blob:measured', videoWidth: 640, videoHeight: 360, hasAudio: true,
  }));
  URL.createObjectURL = vi.fn(() => 'blob:cut');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['cut'], { type: 'video/mp4' }) })));
  projectStore.getState().setStorageEndpoint('');
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  segmentActions.setSession(null);
  __resetEditorStoreForTests();
  vi.unstubAllGlobals();
});

describe('segmentRangeProblem', () => {
  const clip = clipOf();
  it('accepts ranges inside the trimmed window', () => {
    expect(segmentRangeProblem(clip, 2, 6)).toBeNull();
    expect(segmentRangeProblem(clip, 3, 4)).toBeNull();
  });
  it.each([
    [NaN, 3, /Enter a start and end/],
    [-1, 3, /negative/],
    [3, 3.05, /at least/],
    [2, 11, /only 10\.00s long/],
    [1, 4, /trimmed range/],
    [3, 7, /trimmed range/],
  ])('rejects %s–%s', (a, b, message) => {
    expect(segmentRangeProblem(clip, a, b)).toMatch(message);
  });
});

describe('InspectorSegmentSection', () => {
  it('starts from the trimmed range', () => {
    const el = mount(clipOf());
    const [start, end] = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="number"]'));
    expect([start.value, end.value]).toEqual(['2', '6']);
  });

  it('extracts in the browser, then replaces the segment as one undoable edit', async () => {
    mount(clipOf());
    await click('Extract segment');
    await until(() => Boolean(button('Replace with result')));

    expect(cut).toHaveBeenCalledTimes(1);
    expect(cut.mock.calls[0].slice(1, 4)).toEqual([2, 6, 'copy']);
    expect(container!.textContent).toContain('Segment ready — 4.00s');

    await click('Replace with result');
    await until(() => editorStore.getState().clips[0].objectUrl === 'blob:measured');

    const clip = editorStore.getState().clips[0];
    expect([clip.id, clip.trimStart, clip.trimEnd, clip.duration]).toEqual(['c1', 0, 4, 4]);
    expect(button('Replace with result')).toBeUndefined();

    act(() => editorStore.getState().undo());
    const restored = editorStore.getState().clips[0];
    // History restores the saved file (and re-creates its object URL).
    expect([restored.file.name, restored.trimStart, restored.trimEnd, restored.duration]).toEqual(['c1.mp4', 2, 6, 10]);
  });

  it('cuts a sub-range into [before][replaced][after]', async () => {
    mount(clipOf({ trimStart: 0, trimEnd: NaN }));
    const [start, end] = Array.from(container!.querySelectorAll<HTMLInputElement>('input[type="number"]'));
    const setValue = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => { setValue(start, '3'); setValue(end, '7'); });

    await click('Extract segment');
    await until(() => Boolean(button('Replace with result')));
    await click('Replace with result');
    await until(() => editorStore.getState().clips.length === 3);
    expect(editorStore.getState().clips.map((c) => [c.trimStart, c.trimEnd])).toEqual([[0, 3], [0, 4], [7, NaN]]);
  });

  it('refuses a result that is the wrong length and leaves the timeline untouched', async () => {
    mount(clipOf());
    await click('Extract segment');
    await until(() => Boolean(button('Replace with result')));
    // The measured media at replace time is 9s, not the 4s the cut reported.
    mediaInfo.mockImplementation(async () => ({ duration: 9, objectUrl: 'blob:long' }));
    await click('Replace with result');
    await until(() => (container!.textContent ?? '').includes('9.00s but the segment is 4.00s'));
    expect(editorStore.getState().clips[0].objectUrl).toBe('blob:c1');
    expect(button('Replace with result')).toBeDefined(); // can retry or discard
  });

  it('reports a cut of the wrong length instead of offering to replace it', async () => {
    mediaInfo.mockImplementation(async () => ({ duration: 7, objectUrl: 'blob:x' }));
    mount(clipOf());
    await click('Extract segment');
    await until(() => (container!.textContent ?? '').includes('was requested'));
    expect(button('Replace with result')).toBeUndefined();
    expect(button('Dismiss')).toBeDefined();
  });

  it('disables the actions and explains an invalid range', () => {
    mount(clipOf());
    const [, end] = Array.from(container!.querySelectorAll<HTMLInputElement>('input[type="number"]'));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(end, '9');
      end.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.textContent).toContain('trimmed range');
    expect(button('Extract segment')!.disabled).toBe(true);
    expect(button('Send to processing')!.disabled).toBe(true);
  });

  it('warns up front that a huge clip cannot be cut in the browser', () => {
    const big = clipOf();
    Object.defineProperty(big.file, 'size', { value: 3 * 1024 * 1024 * 1024 });
    mount(big);
    expect(container!.textContent).toContain('too large for the browser');
  });

  it('offers only what the chosen backend can do', () => {
    mount(clipOf());
    const [backend, operation] = Array.from(container!.querySelectorAll('select'));
    const options = (select: Element) => Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options(backend)).toEqual(['Browser FFmpeg', 'HF RIFE Space', 'Colab (manual)', 'Contabo job']);
    expect(options(operation)).toEqual(['Extract only']);
    act(() => {
      (backend as HTMLSelectElement).value = 'hf-rife';
      backend.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(options(operation)).toEqual(['RIFE 2× smoother', 'RIFE 4× smoother']);
    expect((operation as HTMLSelectElement).value).toBe('rife2');
  });

  it('Colab: hands over the cut, then accepts only a result of the right length', async () => {
    mount(clipOf());
    const [backend] = Array.from(container!.querySelectorAll('select'));
    act(() => {
      (backend as HTMLSelectElement).value = 'colab';
      backend.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Send to processing');
    await until(() => (container!.textContent ?? '').includes('Import processed result'));
    expect(container!.querySelector('a[download]')).not.toBeNull();
    expect(button('Replace with result')).toBeUndefined(); // not until the processed file is back

    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const give = async (file: File) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    };

    mediaInfo.mockImplementation(async () => ({ duration: 12, objectUrl: 'blob:long' }));
    await give(new File(['x'], 'colab_out.mp4', { type: 'video/mp4' }));
    await until(() => (container!.textContent ?? '').includes('“colab_out.mp4” is 12.00s'));

    mediaInfo.mockImplementation(async () => ({ duration: 4.05, objectUrl: 'blob:ok', videoWidth: 1280, videoHeight: 720 }));
    await give(new File(['x'], 'colab_ok.mp4', { type: 'video/mp4' }));
    await until(() => Boolean(button('Replace with result')));
  });

  it('is not shown for a segment session that belongs to another clip', async () => {
    mount(clipOf());
    segmentActions.setSession({
      request: { source: { kind: 'local', clipId: 'someone-else' }, startSec: 0, endSec: 1 },
      backend: 'browser', operation: 'extract', phase: 'ready', message: 'Segment ready — elsewhere',
      result: { backend: 'browser', url: 'blob:x', durationSec: 1 },
    });
    await act(async () => { await Promise.resolve(); });
    expect(container!.textContent).not.toContain('elsewhere');
  });
});
