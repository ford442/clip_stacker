import { createStore } from 'zustand/vanilla';
import { normalizeFinishingSettings, type FinishingSettings } from '../utils/finishing';
import {
  BUILT_IN_FINISHING_PRESETS,
  FINISHING_PRESET_NAME_MAX,
  FINISHING_PRESET_SCHEMA_ID,
  FINISHING_PRESET_VERSION,
  parseFinishingPreset,
  presetDocumentFromFinishing,
  resolvePresetFinishing,
  summarizePreset,
  validateFinishingObject,
  type FinishingPresetApplyMode,
  type FinishingPresetDocument,
  type FinishingPresetStack,
} from '../utils/finishingPresets';
import { editorStore } from './editorStore';
import { settingsStore } from './settingsStore';

/**
 * User finishing presets — per browser, across projects (localStorage), never
 * part of a project file or the undo history. Applying one goes through
 * `editorStore.applyFinishing`, so the apply itself is one undo step.
 */

export const FINISHING_PRESETS_STORAGE_KEY = 'clip_stacker.finishingPresets.v1';

export interface UserFinishingPreset {
  id: string;
  name: string;
  description?: string;
  apply: FinishingPresetApplyMode;
  /** Validated (partial for `merge`, full for saved stacks) finishing. */
  finishing: FinishingPresetStack;
  createdAt: number;
  updatedAt: number;
}

/** A row the UI lists: a built-in (unless a user preset shadows its name) or a user preset. */
export interface ListedFinishingPreset {
  key: string;
  builtIn: boolean;
  doc: FinishingPresetDocument;
  user?: UserFinishingPreset;
}

interface FinishingPresetState {
  presets: UserFinishingPreset[];
}

export type PresetWriteResult =
  | { ok: true; preset: UserFinishingPreset }
  | { ok: false; error: string; conflictId?: string };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `fp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadPresets(): UserFinishingPreset[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(FINISHING_PRESETS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { presets?: unknown };
    if (!Array.isArray(parsed?.presets)) return [];
    return parsed.presets.flatMap((p): UserFinishingPreset[] => {
      if (!p || typeof p !== 'object') return [];
      const entry = p as Partial<UserFinishingPreset>;
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') return [];
      // A preset saved by a newer build with an unknown field is skipped, not half-applied.
      if (!validateFinishingObject(entry.finishing).ok) return [];
      return [
        {
          id: entry.id,
          name: entry.name.slice(0, FINISHING_PRESET_NAME_MAX),
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          apply: entry.apply === 'merge' ? 'merge' : 'replace',
          finishing: entry.finishing as FinishingPresetStack,
          createdAt: Number(entry.createdAt) || 0,
          updatedAt: Number(entry.updatedAt) || 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Persist; returns an error message (e.g. storage full) instead of throwing. */
function persist(presets: UserFinishingPreset[]): string | null {
  try {
    localStorage.setItem(
      FINISHING_PRESETS_STORAGE_KEY,
      JSON.stringify({ version: FINISHING_PRESET_VERSION, presets }),
    );
    return null;
  } catch (e) {
    const name = (e as { name?: string })?.name ?? '';
    return /quota/i.test(name) || /quota/i.test(String(e))
      ? 'Browser storage is full — delete a preset (custom LUTs are large) and try again.'
      : `Could not save presets: ${(e as Error)?.message ?? e}`;
  }
}

export const finishingPresetStore = createStore<FinishingPresetState>(() => ({
  presets: loadPresets(),
}));

function commit(next: UserFinishingPreset[]): string | null {
  const error = persist(next);
  if (!error) finishingPresetStore.setState({ presets: next });
  return error;
}

export function userPresetDocument(p: UserFinishingPreset): FinishingPresetDocument {
  return {
    schema: FINISHING_PRESET_SCHEMA_ID,
    version: FINISHING_PRESET_VERSION,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    apply: p.apply,
    finishing: p.finishing,
  };
}

/** Built-ins first (unless shadowed by a user preset of the same name), then user presets. */
export function listFinishingPresets(
  presets: UserFinishingPreset[] = finishingPresetStore.getState().presets,
): ListedFinishingPreset[] {
  const builtIns = BUILT_IN_FINISHING_PRESETS.filter(
    (b) => !presets.some((p) => sameName(p.name, b.name)),
  ).map((doc) => ({ key: `builtin:${doc.name}`, builtIn: true, doc }));
  const user = presets.map((p) => ({ key: p.id, builtIn: false, doc: userPresetDocument(p), user: p }));
  return [...builtIns, ...user];
}

/**
 * Save a preset document under its name. A name already used by another user
 * preset is a conflict unless `overwrite`; a built-in's name is allowed and
 * shadows the built-in (deleting the user preset brings it back).
 */
export function saveFinishingPreset(
  doc: Pick<FinishingPresetDocument, 'name' | 'description' | 'apply' | 'finishing'>,
  { overwrite = false }: { overwrite?: boolean } = {},
): PresetWriteResult {
  const name = doc.name.trim().slice(0, FINISHING_PRESET_NAME_MAX);
  if (!name) return { ok: false, error: 'Give the preset a name.' };
  const check = validateFinishingObject(doc.finishing);
  if (!check.ok) return { ok: false, error: check.errors.join(' ') };
  const presets = finishingPresetStore.getState().presets;
  const existing = presets.find((p) => sameName(p.name, name));
  if (existing && !overwrite) {
    return { ok: false, error: `A preset named "${existing.name}" already exists.`, conflictId: existing.id };
  }
  const now = Date.now();
  const preset: UserFinishingPreset = {
    id: existing?.id ?? newId(),
    name,
    ...(doc.description?.trim() ? { description: doc.description.trim() } : {}),
    apply: doc.apply,
    finishing: structuredClone(doc.finishing),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = existing
    ? presets.map((p) => (p.id === existing.id ? preset : p))
    : [...presets, preset];
  const error = commit(next);
  return error ? { ok: false, error } : { ok: true, preset };
}

/** Save the project's current stack (every pass) as a user preset. */
export function saveCurrentFinishingAsPreset(
  name: string,
  options: { overwrite?: boolean; description?: string } = {},
): PresetWriteResult {
  const doc = presetDocumentFromFinishing(name, settingsStore.getState().finishing, options.description);
  return saveFinishingPreset({ ...doc, name }, options);
}

export function renameFinishingPreset(id: string, name: string): PresetWriteResult {
  const trimmed = name.trim().slice(0, FINISHING_PRESET_NAME_MAX);
  const presets = finishingPresetStore.getState().presets;
  const target = presets.find((p) => p.id === id);
  if (!target) return { ok: false, error: 'That preset no longer exists.' };
  if (!trimmed) return { ok: false, error: 'Give the preset a name.' };
  const clash = presets.find((p) => p.id !== id && sameName(p.name, trimmed));
  if (clash) return { ok: false, error: `A preset named "${clash.name}" already exists.`, conflictId: clash.id };
  const renamed = { ...target, name: trimmed, updatedAt: Date.now() };
  const error = commit(presets.map((p) => (p.id === id ? renamed : p)));
  return error ? { ok: false, error } : { ok: true, preset: renamed };
}

export function deleteFinishingPreset(id: string): void {
  const presets = finishingPresetStore.getState().presets;
  commit(presets.filter((p) => p.id !== id));
}

/** Apply a validated preset document: one undo step, plus a status line. */
export function applyFinishingPresetDocument(doc: FinishingPresetDocument): FinishingSettings {
  const next = resolvePresetFinishing(doc, settingsStore.getState().finishing);
  editorStore.getState().applyFinishing(next);
  settingsStore
    .getState()
    .setStatus(`Applied finishing preset "${doc.name}" (${summarizePreset(doc)}). Undo restores the previous stack.`);
  return next;
}

export interface ApplyPresetResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  name?: string;
  summary?: string;
  saved?: boolean;
}

/**
 * Validate → apply (→ optionally save) a preset from JSON text or an object.
 * All-or-nothing: an invalid preset changes nothing.
 */
export function applyFinishingPresetInput(
  input: unknown,
  { save = false, overwrite = false }: { save?: boolean; overwrite?: boolean } = {},
): ApplyPresetResult {
  const parsed = parseFinishingPreset(input);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };
  const { preset, warnings } = parsed;
  let saved = false;
  if (save) {
    const result = saveFinishingPreset(preset, { overwrite });
    if (!result.ok) return { ok: false, errors: [result.error], warnings };
    saved = true;
  }
  applyFinishingPresetDocument(preset);
  return { ok: true, errors: [], warnings, name: preset.name, summary: summarizePreset(preset), saved };
}

/** Find a listed preset by (case-insensitive) name. */
export function findFinishingPreset(name: string): ListedFinishingPreset | undefined {
  return listFinishingPresets().find((p) => sameName(p.doc.name, name));
}

/** The project's stack, normalized and detached (for export / the API). */
export function currentFinishingSnapshot(): FinishingSettings {
  return structuredClone(normalizeFinishingSettings(settingsStore.getState().finishing));
}

/** Test-only: reload from storage. */
export function __reloadFinishingPresetsForTests(): void {
  finishingPresetStore.setState({ presets: loadPresets() });
}
