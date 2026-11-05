import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RootErrorBoundary } from './RootErrorBoundary';
import { AUTO_SAVE_STORAGE_KEY } from '../project/autoSave';

vi.mock('../actions/debugReport', () => ({
  generateDebugReport: vi.fn((ctx: { error: Error }) => `REPORT: ${ctx.error.message}\n${ctx.error.stack}`),
}));

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error('kaboom');
  return <p>editor</p>;
}

describe('RootErrorBoundary', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    shouldThrow = true;
    localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function mount() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RootErrorBoundary>
          <Bomb />
        </RootErrorBoundary>,
      );
    });
  }

  const button = (label: RegExp) =>
    Array.from(container.querySelectorAll('button')).find((b) => label.test(b.textContent ?? ''))!;

  it('shows a recovery screen instead of a blank page', async () => {
    await mount();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/hit an error/);
    expect(alert?.textContent).toMatch(/kaboom/);
    expect(button(/^Reload$/)).toBeTruthy();
    expect(alert?.textContent).toMatch(/No autosave/);
  });

  it('offers the autosave when there is one', async () => {
    localStorage.setItem(
      AUTO_SAVE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        selectedClipId: null,
        exportSettings: {},
        project: { schemaVersion: 2, clips: [{ id: 'a' }], transitions: [] },
      }),
    );
    await mount();
    expect(button(/recover autosave/)).toBeTruthy();
    expect(container.textContent).toMatch(/1 clip\)/);
  });

  it('Copy Debug puts the crash (with component stack) on the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount();
    await act(async () => {
      button(/Copy Debug/).click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    });
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toMatch(/REPORT: kaboom/);
    expect(text).toMatch(/Component stack/);
    expect(container.textContent).toMatch(/copied/);
  });

  it('Try again re-renders the editor', async () => {
    await mount();
    shouldThrow = false;
    await act(async () => {
      button(/Try again/).click();
    });
    expect(container.textContent).toBe('editor');
  });
});
