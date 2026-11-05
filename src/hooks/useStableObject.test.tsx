import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { shallowEqual, useStableObject } from './useStableObject';

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function renderStable<T extends object>(initial: T) {
  const seen: T[] = [];
  function Probe({ value }: { value: T }) {
    seen.push(useStableObject(value));
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(<Probe value={initial} />));
  return {
    seen,
    rerender: (value: T) => act(() => root!.render(<Probe value={value} />)),
  };
}

describe('useStableObject', () => {
  it('keeps the previous bundle while every member is identical', () => {
    const a = () => {};
    const b = () => {};
    const probe = renderStable({ a, b, n: 1 });
    probe.rerender({ a, b, n: 1 });
    expect(probe.seen[1]).toBe(probe.seen[0]);
    probe.rerender({ a, b, n: 2 });
    expect(probe.seen[2]).not.toBe(probe.seen[0]);
    expect(probe.seen[2]?.n).toBe(2);
  });

  it('compares keys as well as values', () => {
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqual({ a: NaN }, { a: NaN })).toBe(true);
  });
});
