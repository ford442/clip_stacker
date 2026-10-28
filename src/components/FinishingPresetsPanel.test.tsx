import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { FinishingPresetsPanel } from './FinishingPresetsPanel';
import { EffectsStack } from './EffectsStack';
import { settingsStore } from '../store';
import { __resetEditorStoreForTests, editorStore } from '../store/editorStore';
import { __resetUiStoreForTests } from '../store/uiStore';
import { __reloadFinishingPresetsForTests, finishingPresetStore } from '../store/finishingPresetStore';
import { DEFAULT_FINISHING } from '../utils/finishing';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function typeInto(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const button = (label: string, scope: string = '') =>
  Array.from(container.querySelectorAll(`${scope} button`)).find((b) => b.textContent === label)!;

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  __reloadFinishingPresetsForTests();
  __resetEditorStoreForTests();
  __resetUiStoreForTests();
  settingsStore.setState({ finishing: structuredClone(DEFAULT_FINISHING) });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FinishingPresetsPanel', () => {
  beforeEach(() => {
    act(() => root.render(<FinishingPresetsPanel />));
  });

  it('lists the built-ins and applies one as an undo step', () => {
    const rows = Array.from(container.querySelectorAll('.finishing-preset-row'));
    expect(rows.map((r) => r.querySelector('.finishing-preset-name')?.firstChild?.textContent)).toEqual([
      'Clean',
      'Film look',
      'High contrast',
      'Soft',
    ]);
    click(rows[2].querySelector('button')!);
    expect(settingsStore.getState().finishing.curves?.enabled).toBe(true);
    expect(container.textContent).toContain('Applied "High contrast"');
    act(() => editorStore.getState().undo());
    expect(settingsStore.getState().finishing).toEqual(DEFAULT_FINISHING);
  });

  it('pasted invalid JSON shows the errors and applies nothing', () => {
    const textarea = container.querySelector('textarea')!;
    typeInto(textarea, '{"finishing": {"grain": {"amount": 2}, "sparkle": {}}}');
    click(button('Apply', '.finishing-preset-import'));
    const alert = container.querySelector('[role=alert]')!;
    expect(alert.textContent).toContain('Nothing was applied');
    expect(alert.textContent).toContain('finishing.grain.amount is 2');
    expect(alert.textContent).toContain('finishing.sparkle is not a finishing pass');
    expect(settingsStore.getState().finishing).toEqual(DEFAULT_FINISHING);
  });

  it('pasted valid JSON validates, applies and can be saved', () => {
    const textarea = container.querySelector('textarea')!;
    typeInto(
      textarea,
      JSON.stringify({ name: 'From agent', finishing: { bloom: { enabled: true, amount: 0.4 } } }),
    );
    click(button('Validate'));
    expect(container.textContent).toContain('Valid: "From agent"');
    click(button('Apply & save'));
    expect(settingsStore.getState().finishing.bloom?.enabled).toBe(true);
    expect(finishingPresetStore.getState().presets.map((p) => p.name)).toEqual(['From agent']);
    expect(container.textContent).toContain('From agent');
  });

  it('saves the current stack, asks before replacing, renames and deletes', () => {
    const name = container.querySelector<HTMLInputElement>('input[aria-label="New preset name"]')!;
    typeInto(name, 'Mine');
    click(button('Save current as preset'));
    expect(finishingPresetStore.getState().presets).toHaveLength(1);
    typeInto(name, 'mine');
    click(button('Save current as preset'));
    expect(button('Replace')).toBeTruthy();
    click(button('Replace'));
    expect(finishingPresetStore.getState().presets).toHaveLength(1);

    click(button('Rename'));
    const rename = container.querySelector<HTMLInputElement>('.finishing-preset-rename')!;
    typeInto(rename, 'Renamed');
    click(button('Save name'));
    expect(finishingPresetStore.getState().presets[0].name).toBe('Renamed');

    click(button('Delete'));
    click(button('Confirm delete'));
    expect(finishingPresetStore.getState().presets).toEqual([]);
  });
});

describe('Effects Stack preset picker', () => {
  it('applies the chosen preset', () => {
    act(() => root.render(<EffectsStack />));
    const select = container.querySelector<HTMLSelectElement>('select.effects-preset-select')!;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Soft');
    const soft = Array.from(select.options).find((o) => o.textContent === 'Soft')!;
    act(() => {
      select.value = soft.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(settingsStore.getState().finishing.bloom?.enabled).toBe(true);
    expect(editorStore.getState().undoDepth).toBe(1);
  });
});
