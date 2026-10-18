import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EffectsStack } from './EffectsStack';
import { settingsStore, uiStore } from '../store';
import { __resetUiStoreForTests } from '../store/uiStore';
import { DEFAULT_FINISHING } from '../utils/finishing';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function click(el: Element | null) {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('EffectsStack', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetUiStoreForTests();
    settingsStore.setState({ finishing: structuredClone(DEFAULT_FINISHING) });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<EffectsStack />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const chip = (name: string) =>
    Array.from(container.querySelectorAll<HTMLLabelElement>('.effects-chip')).find((l) =>
      l.textContent?.includes(name),
    )!;

  it('shows one chip per finishing pass', () => {
    expect(container.querySelectorAll('.effects-chip')).toHaveLength(8);
  });

  it('toggling a chip edits the project finishing settings', () => {
    click(chip('Sharpen').querySelector('input'));
    expect(settingsStore.getState().finishing.sharpen?.enabled).toBe(true);
    click(chip('Sharpen').querySelector('input'));
    expect(settingsStore.getState().finishing.sharpen?.enabled).toBe(false);
  });

  it('bypass-all is preview view state and leaves the settings alone', () => {
    click(chip('Sharpen').querySelector('input'));
    const before = settingsStore.getState().finishing;
    click(container.querySelector('.effects-bypass'));
    expect(uiStore.getState().finishingView.bypassAll).toBe(true);
    expect(settingsStore.getState().finishing).toBe(before);
    expect(container.querySelector('.effects-stack-note')?.textContent).toContain('Exports still apply');
    click(container.querySelector('.effects-reset'));
    expect(uiStore.getState().finishingView.bypassAll).toBe(false);
  });

  it('details list offers per-pass amount and Before', () => {
    click(container.querySelector('.effects-details-toggle'));
    expect(container.querySelectorAll('.effects-row')).toHaveLength(8);
    click(chip('Grain').querySelector('input'));
    const grainRow = Array.from(container.querySelectorAll('.effects-row')).find((r) =>
      r.textContent?.includes('Grain'),
    )!;
    click(grainRow.querySelector('.effects-before'));
    expect(uiStore.getState().finishingView.before).toEqual(['grain']);
  });

  it('Edit asks the Inspector for the Export tab', () => {
    click(container.querySelector('.effects-details-toggle'));
    click(container.querySelector('.effects-edit'));
    expect(uiStore.getState().inspectorTabRequest?.tab).toBe('export');
  });
});
