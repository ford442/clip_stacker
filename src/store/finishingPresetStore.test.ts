import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetEditorStoreForTests, editorStore } from './editorStore';
import { settingsStore } from './settingsStore';
import {
  FINISHING_PRESETS_STORAGE_KEY,
  __reloadFinishingPresetsForTests,
  applyFinishingPresetDocument,
  applyFinishingPresetInput,
  deleteFinishingPreset,
  finishingPresetStore,
  listFinishingPresets,
  renameFinishingPreset,
  saveCurrentFinishingAsPreset,
} from './finishingPresetStore';
import { DEFAULT_FINISHING, normalizeFinishingSettings } from '../utils/finishing';
import { BUILT_IN_FINISHING_PRESETS } from '../utils/finishingPresets';
import {
  APPLY_FINISHING_PRESET_EVENT,
  FINISHING_PRESET_RESULT_EVENT,
  installFinishingPresetApi,
  type FinishingPresetApi,
} from '../utils/finishingPresetApi';

const finishing = () => settingsStore.getState().finishing;

const withSharpen = () =>
  normalizeFinishingSettings({
    ...DEFAULT_FINISHING,
    sharpen: { ...DEFAULT_FINISHING.sharpen!, enabled: true, amount: 0.42 },
  });

beforeEach(() => {
  localStorage.clear();
  __reloadFinishingPresetsForTests();
  __resetEditorStoreForTests();
  settingsStore.setState({ finishing: structuredClone(DEFAULT_FINISHING), status: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('user finishing presets', () => {
  it('lists the built-ins first, then saved presets', () => {
    expect(listFinishingPresets().map((p) => p.doc.name)).toEqual(
      BUILT_IN_FINISHING_PRESETS.map((p) => p.name),
    );
    settingsStore.setState({ finishing: withSharpen() });
    const saved = saveCurrentFinishingAsPreset('My crisp look');
    expect(saved.ok).toBe(true);
    const listed = listFinishingPresets();
    expect(listed.at(-1)?.doc.name).toBe('My crisp look');
    expect(listed.at(-1)?.builtIn).toBe(false);
  });

  it('persists across reloads and keeps the exact stack', () => {
    settingsStore.setState({ finishing: withSharpen() });
    saveCurrentFinishingAsPreset('Persisted');
    __reloadFinishingPresetsForTests();
    const preset = finishingPresetStore.getState().presets[0];
    expect(preset.name).toBe('Persisted');
    expect(normalizeFinishingSettings(preset.finishing as never)).toEqual(withSharpen());
  });

  it('refuses a duplicate name unless overwriting; rename checks clashes too', () => {
    saveCurrentFinishingAsPreset('One');
    const dup = saveCurrentFinishingAsPreset('one');
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.conflictId).toBeTruthy();
    settingsStore.setState({ finishing: withSharpen() });
    expect(saveCurrentFinishingAsPreset('ONE', { overwrite: true }).ok).toBe(true);
    expect(finishingPresetStore.getState().presets).toHaveLength(1);
    saveCurrentFinishingAsPreset('Two');
    const [one, two] = finishingPresetStore.getState().presets;
    expect(renameFinishingPreset(two.id, 'one').ok).toBe(false);
    expect(renameFinishingPreset(two.id, 'Second').ok).toBe(true);
    deleteFinishingPreset(one.id);
    expect(finishingPresetStore.getState().presets.map((p) => p.name)).toEqual(['Second']);
    expect(saveCurrentFinishingAsPreset('   ').ok).toBe(false);
  });

  it('a user preset named like a built-in shadows it; deleting brings it back', () => {
    saveCurrentFinishingAsPreset('Film look');
    const names = listFinishingPresets().map((p) => p.doc.name);
    expect(names.filter((n) => n === 'Film look')).toHaveLength(1);
    expect(listFinishingPresets().find((p) => p.doc.name === 'Film look')?.builtIn).toBe(false);
    deleteFinishingPreset(finishingPresetStore.getState().presets[0].id);
    expect(listFinishingPresets().find((p) => p.doc.name === 'Film look')?.builtIn).toBe(true);
  });

  it('reports a full storage instead of throwing, and keeps the list unchanged', () => {
    // A Storage object turns property writes into items, so stub the global
    // rather than spying on the instance.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    const result = saveCurrentFinishingAsPreset('Too big');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/storage is full/);
    expect(finishingPresetStore.getState().presets).toEqual([]);
  });

  it('skips corrupt or unknown stored entries on load', () => {
    localStorage.setItem(
      FINISHING_PRESETS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        presets: [
          { id: 'a', name: 'Good', apply: 'replace', finishing: { grain: { enabled: true } } },
          { id: 'b', name: 'Bad', apply: 'replace', finishing: { grain: { sparkle: 1 } } },
          'nonsense',
        ],
      }),
    );
    __reloadFinishingPresetsForTests();
    expect(finishingPresetStore.getState().presets.map((p) => p.name)).toEqual(['Good']);
    localStorage.setItem(FINISHING_PRESETS_STORAGE_KEY, '{not json');
    __reloadFinishingPresetsForTests();
    expect(finishingPresetStore.getState().presets).toEqual([]);
  });
});

describe('applying presets with undo', () => {
  it('applying is one undo step; redo re-applies', () => {
    settingsStore.setState({ finishing: withSharpen() });
    const before = finishing();
    applyFinishingPresetDocument(BUILT_IN_FINISHING_PRESETS[1]);
    const after = finishing();
    expect(after.grain?.enabled).toBe(true);
    expect(after.sharpen?.enabled).toBe(false); // replace: omitted passes off
    expect(editorStore.getState().undoDepth).toBe(1);
    expect(settingsStore.getState().status).toMatch(/Applied finishing preset "Film look"/);

    editorStore.getState().undo();
    expect(finishing()).toEqual(before);
    editorStore.getState().redo();
    expect(finishing()).toEqual(after);
  });

  it('other undo steps leave finishing alone (existing behaviour)', () => {
    editorStore.getState().addTrack('video');
    settingsStore.setState({ finishing: withSharpen() }); // a manual finishing edit
    editorStore.getState().undo(); // undo the track add
    expect(finishing()).toEqual(withSharpen());
    editorStore.getState().redo();
    expect(finishing()).toEqual(withSharpen());
  });

  it('undo after a preset then a timeline edit restores in order', () => {
    applyFinishingPresetDocument(BUILT_IN_FINISHING_PRESETS[0]);
    const clean = finishing();
    editorStore.getState().addTrack('video');
    editorStore.getState().undo(); // the track
    expect(finishing()).toEqual(clean);
    editorStore.getState().undo(); // the preset
    expect(finishing()).toEqual(DEFAULT_FINISHING);
  });

  it('an invalid preset changes nothing and records no history', () => {
    settingsStore.setState({ finishing: withSharpen() });
    const result = applyFinishingPresetInput('{"finishing": {"grain": {"amount": 7}}}');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/finishing\.grain\.amount is 7/);
    expect(finishing()).toEqual(withSharpen());
    expect(editorStore.getState().undoDepth).toBe(0);
  });

  it('apply & save stores the preset under its name', () => {
    const result = applyFinishingPresetInput(
      JSON.stringify({ name: 'Agent glow', apply: 'merge', finishing: { bloom: { enabled: true, amount: 0.5 } } }),
      { save: true },
    );
    expect(result).toMatchObject({ ok: true, name: 'Agent glow', saved: true });
    expect(finishing().bloom?.enabled).toBe(true);
    const saved = finishingPresetStore.getState().presets[0];
    expect(saved).toMatchObject({ name: 'Agent glow', apply: 'merge' });
  });
});

describe('window.clipStacker.finishing API', () => {
  let uninstall: () => void;
  const api = () => (window as unknown as { clipStacker: { finishing: FinishingPresetApi } }).clipStacker.finishing;

  beforeEach(() => {
    uninstall = installFinishingPresetApi(window);
  });
  afterEach(() => uninstall());

  it('validates, applies, lists and reads back', () => {
    expect(api().validate({ grian: {} }).ok).toBe(false);
    expect(api().list()).toContain('High contrast');
    const result = api().apply({ name: 'Via API', finishing: { curves: { enabled: true, levels: { gamma: 1.3 } } } });
    expect(result.ok).toBe(true);
    expect(api().get().curves?.levels.gamma).toBe(1.3);
    expect(api().applyPreset('soft').ok).toBe(true);
    expect(api().applyPreset('nope').errors[0]).toMatch(/No preset named "nope"/);
    expect((api().schema() as { title: string }).title).toBe('Clip Stacker finishing preset');
  });

  it('applies from a same-page CustomEvent and answers with a result event', () => {
    const results: unknown[] = [];
    const onResult = (e: Event) => results.push((e as CustomEvent).detail);
    window.addEventListener(FINISHING_PRESET_RESULT_EVENT, onResult);
    window.dispatchEvent(
      new CustomEvent(APPLY_FINISHING_PRESET_EVENT, {
        detail: { preset: { finishing: { grain: { enabled: true, amount: 0.3 } } } },
      }),
    );
    window.dispatchEvent(new CustomEvent(APPLY_FINISHING_PRESET_EVENT, { detail: { preset: 'nope' } }));
    window.removeEventListener(FINISHING_PRESET_RESULT_EVENT, onResult);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false });
    expect(finishing().grain?.amount).toBe(0.3);
  });
});
