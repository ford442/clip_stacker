import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CollapsedRail,
  PanelSplitter,
  TimelineSplitter,
  WORKSPACE_ZONE_IDS,
  WorkspaceControls,
} from './WorkspaceChrome';
import { __resetLayoutStoreForTests, layoutStore } from '../store/layoutStore';
import { useWorkspaceLayoutVars } from '../hooks/useWorkspaceLayoutVars';
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LIMITS } from '../utils/workspaceLayout';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Harness() {
  const shellRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLElement>(null);
  useWorkspaceLayoutVars(shellRef);
  return (
    <main ref={shellRef} data-testid="shell">
      <WorkspaceControls />
      <section ref={gridRef}>
        <div id={WORKSPACE_ZONE_IDS.library}>
          <CollapsedRail side="library" />
        </div>
        <PanelSplitter side="library" gridRef={gridRef} />
        <PanelSplitter side="inspector" gridRef={gridRef} />
      </section>
      <TimelineSplitter gridRef={gridRef} shellRef={shellRef} />
    </main>
  );
}

function render() {
  act(() => {
    root.render(<Harness />);
  });
}

const shell = () => container.querySelector('main') as HTMLElement;
const splitter = (label: string) =>
  container.querySelector(`[role="separator"][aria-label="${label}"]`) as HTMLElement | null;

function key(el: Element, k: string, shiftKey = false) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
  });
}

function clickButton(name: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!button) throw new Error(`No button "${name}"`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('workspace chrome', () => {
  beforeEach(() => {
    __resetLayoutStoreForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('mirrors the layout onto the shell as CSS variables and data attributes', () => {
    render();
    expect(shell().style.getPropertyValue('--ws-library-width')).toBe('260px');
    expect(shell().getAttribute('data-density')).toBe('comfortable');

    act(() => layoutStore.getState().setVerticalSplit(500, 200));
    expect(shell().style.getPropertyValue('--ws-upper-height')).toBe('500px');
    expect(shell().getAttribute('data-timeline-fixed')).toBe('true');

    act(() => layoutStore.getState().resetVerticalSplit());
    expect(shell().style.getPropertyValue('--ws-upper-height')).toBe('');
    expect(shell().hasAttribute('data-timeline-fixed')).toBe(false);
  });

  it('exposes the column splitters as focusable ARIA separators', () => {
    render();
    const lib = splitter('Resize Library panel');
    expect(lib).not.toBeNull();
    expect(lib?.getAttribute('aria-orientation')).toBe('vertical');
    expect(lib?.getAttribute('aria-controls')).toBe(WORKSPACE_ZONE_IDS.library);
    expect(lib?.getAttribute('aria-valuenow')).toBe('260');
    expect(lib?.tabIndex).toBe(0);
  });

  it('resizes the library and inspector from the keyboard', () => {
    render();
    // happy-dom lays nothing out, so the zones measure 0 and the stored width
    // is the starting point.
    key(splitter('Resize Library panel')!, 'ArrowRight');
    expect(layoutStore.getState().libraryWidth).toBe(276);
    key(splitter('Resize Library panel')!, 'ArrowLeft', true);
    expect(layoutStore.getState().libraryWidth).toBe(212);
    // The inspector's splitter is on its left edge: right = narrower.
    key(splitter('Resize Inspector panel')!, 'ArrowLeft');
    expect(layoutStore.getState().inspectorWidth).toBe(296);
    key(splitter('Resize Inspector panel')!, 'Home');
    expect(layoutStore.getState().inspectorWidth).toBe(WORKSPACE_LIMITS.inspectorMin);
  });

  it('collapses a side with Enter and brings it back from the rail', () => {
    render();
    key(splitter('Resize Library panel')!, 'Enter');
    expect(layoutStore.getState().libraryCollapsed).toBe(true);
    expect(shell().getAttribute('data-library-collapsed')).toBe('true');
    expect(splitter('Resize Library panel')).toBeNull();

    const rail = container.querySelector('.workspace-rail') as HTMLButtonElement;
    expect(rail.getAttribute('aria-expanded')).toBe('false');
    act(() => rail.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(layoutStore.getState().libraryCollapsed).toBe(false);
    expect(container.querySelector('.workspace-rail')).toBeNull();
  });

  it('resizes a column by pointer drag, measured from where the drag started', () => {
    render();
    const lib = splitter('Resize Library panel')!;
    const pointer = (type: string, clientX: number) =>
      act(() => {
        lib.dispatchEvent(
          new PointerEvent(type, { pointerId: 1, button: 0, clientX, clientY: 0, bubbles: true }),
        );
      });
    pointer('pointerdown', 100);
    expect(document.body.classList.contains('workspace-is-resizing')).toBe(true);
    pointer('pointermove', 130);
    pointer('pointermove', 160);
    pointer('pointerup', 160);
    expect(layoutStore.getState().libraryWidth).toBe(320);
    expect(document.body.classList.contains('workspace-is-resizing')).toBe(false);
  });

  it('resets a column on double-click', () => {
    render();
    act(() => layoutStore.getState().setSideWidth('inspector', 420));
    const insp = splitter('Resize Inspector panel')!;
    act(() => insp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(layoutStore.getState().inspectorWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.inspectorWidth);
  });

  it('moves the timeline divider with the arrow keys', () => {
    render();
    act(() => layoutStore.getState().setVerticalSplit(500, 300));
    key(splitter('Resize preview area and timeline')!, 'ArrowDown', true);
    expect(layoutStore.getState()).toMatchObject({ upperHeight: 564, timelineHeight: 236 });
    key(splitter('Resize preview area and timeline')!, 'Home');
    expect(layoutStore.getState().upperHeight).toBe(WORKSPACE_LIMITS.upperMin);
  });

  it('drives toggles, density, full width and reset from the header', () => {
    render();
    clickButton('Inspector');
    expect(layoutStore.getState().inspectorCollapsed).toBe(true);
    clickButton('Compact controls');
    expect(shell().getAttribute('data-density')).toBe('compact');
    clickButton('Full width');
    expect(shell().hasAttribute('data-full-width')).toBe(false);
    clickButton('Reset layout');
    expect(layoutStore.getState()).toMatchObject({
      inspectorCollapsed: false,
      density: 'comfortable',
      fullWidth: true,
    });
  });
});
