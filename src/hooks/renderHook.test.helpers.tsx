/**
 * Minimal `renderHook` for hook tests (the repo has no testing-library):
 * mounts a probe component under happy-dom and exposes the hook's latest
 * return value. Wrap state changes in `act`.
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

export interface RenderedHook<T> {
  readonly current: T;
  rerender(): void;
  unmount(): void;
}

export function renderHook<T>(useHook: () => T): RenderedHook<T> {
  const container = document.createElement('div');
  let root: Root | null = createRoot(container);
  let value: { current: T } | null = null;
  function Probe() {
    value = { current: useHook() };
    return null;
  }
  act(() => root!.render(<Probe />));
  return {
    get current() {
      if (!value) throw new Error('hook has not rendered');
      return value.current;
    },
    rerender() {
      act(() => root!.render(<Probe />));
    },
    unmount() {
      act(() => root?.unmount());
      root = null;
    },
  };
}

export { act };
