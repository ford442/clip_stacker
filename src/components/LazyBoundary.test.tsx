import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { ReactNode } from 'react';
import { LazyBoundary, lazyNamed } from './LazyBoundary';

function Panel({ text }: { text: string }) {
  return <p>{text}</p>;
}

describe('LazyBoundary', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(node: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(node));
    return container;
  }

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it('shows a loading line, then the named export once its chunk resolves', async () => {
    let resolve!: (module: { Panel: typeof Panel }) => void;
    const LazyPanel = lazyNamed(
      () => new Promise<{ Panel: typeof Panel }>((r) => (resolve = r)),
      'Panel',
    );
    const el = mount(
      <LazyBoundary label="Captions">
        <LazyPanel text="loaded" />
      </LazyBoundary>,
    );
    expect(el.textContent).toBe('Loading captions…');

    await act(async () => resolve({ Panel }));
    expect(el.textContent).toBe('loaded');
  });

  it('turns a failed chunk load into a reload prompt instead of unmounting the app', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const LazyPanel = lazyNamed<'Panel', { Panel: typeof Panel }>(
      () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
      'Panel',
    );
    const el = mount(
      <div>
        <span>editor</span>
        <LazyBoundary label="Export settings">
          <LazyPanel text="never" />
        </LazyBoundary>
      </div>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Export settings failed to load');
    expect(alert?.querySelector('button')?.textContent).toBe('Reload');
    expect(el.textContent).toContain('editor');
  });
});
