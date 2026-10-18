import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { InspectorSection } from './InspectorSection';
import { SECTION_STATE_STORAGE_KEY } from '../../utils/sectionState';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function mount(defaultOpen?: boolean) {
  act(() =>
    root.render(
      <InspectorSection id="t.one" title="One" defaultOpen={defaultOpen}>
        <span>body</span>
      </InspectorSection>,
    ),
  );
  return container.querySelector('details')!;
}

describe('InspectorSection', () => {
  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('starts at its default and honours a remembered choice', () => {
    expect(mount(false).open).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    localStorage.setItem(SECTION_STATE_STORAGE_KEY, JSON.stringify({ 't.one': true }));
    expect(mount(false).open).toBe(true);
  });

  it('remembers a toggle', () => {
    const details = mount(true);
    expect(details.open).toBe(true);
    act(() => {
      details.open = false;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(JSON.parse(localStorage.getItem(SECTION_STATE_STORAGE_KEY)!)).toEqual({ 't.one': false });
  });
});
