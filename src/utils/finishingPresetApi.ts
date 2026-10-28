/**
 * Same-page API for tools and AI agents (browser automation, devtools):
 *
 *   window.clipStacker.finishing.apply(presetJsonOrObject, { save: true })
 *   window.clipStacker.finishing.validate(presetJsonOrObject)
 *   window.clipStacker.finishing.schema()      // JSON Schema
 *   window.clipStacker.finishing.agentBrief()  // instructions + example + schema
 *   window.clipStacker.finishing.get()         // current stack (a copy)
 *   window.clipStacker.finishing.list()        // preset names
 *   window.clipStacker.finishing.applyPreset('Film look')
 *
 * or, without touching globals:
 *
 *   window.dispatchEvent(new CustomEvent('clip-stacker:apply-finishing-preset',
 *     { detail: { preset, save: false } }))
 *   // → 'clip-stacker:finishing-preset-result' with { ok, errors, … }
 *
 * Both go through the same validate → apply (one undo step) path as the UI.
 * Deliberately no cross-origin `postMessage` listener: only code already
 * running in the page can change the grade.
 */

import {
  FINISHING_PRESET_VERSION,
  finishingPresetAgentBrief,
  finishingPresetJsonSchema,
  parseFinishingPreset,
  summarizePreset,
} from './finishingPresets';
import {
  applyFinishingPresetDocument,
  applyFinishingPresetInput,
  currentFinishingSnapshot,
  findFinishingPreset,
  listFinishingPresets,
  type ApplyPresetResult,
} from '../store/finishingPresetStore';

export const APPLY_FINISHING_PRESET_EVENT = 'clip-stacker:apply-finishing-preset';
export const FINISHING_PRESET_RESULT_EVENT = 'clip-stacker:finishing-preset-result';

export interface FinishingPresetApi {
  version: number;
  schema: () => Record<string, unknown>;
  agentBrief: () => string;
  validate: (input: unknown) => ApplyPresetResult;
  apply: (input: unknown, options?: { save?: boolean; overwrite?: boolean }) => ApplyPresetResult;
  applyPreset: (name: string) => ApplyPresetResult;
  get: () => ReturnType<typeof currentFinishingSnapshot>;
  list: () => string[];
}

export function createFinishingPresetApi(): FinishingPresetApi {
  return {
    version: FINISHING_PRESET_VERSION,
    schema: finishingPresetJsonSchema,
    agentBrief: finishingPresetAgentBrief,
    validate: (input) => {
      const parsed = parseFinishingPreset(input);
      return parsed.ok
        ? { ok: true, errors: [], warnings: parsed.warnings, name: parsed.preset.name, summary: summarizePreset(parsed.preset) }
        : { ok: false, errors: parsed.errors, warnings: [] };
    },
    apply: (input, options) => applyFinishingPresetInput(input, options),
    applyPreset: (name) => {
      const found = findFinishingPreset(name);
      if (!found) {
        return {
          ok: false,
          errors: [`No preset named "${name}". Available: ${listFinishingPresets().map((p) => p.doc.name).join(', ')}.`],
          warnings: [],
        };
      }
      applyFinishingPresetDocument(found.doc);
      return { ok: true, errors: [], warnings: [], name: found.doc.name, summary: summarizePreset(found.doc) };
    },
    get: currentFinishingSnapshot,
    list: () => listFinishingPresets().map((p) => p.doc.name),
  };
}

type ClipStackerGlobal = { finishing?: FinishingPresetApi } & Record<string, unknown>;

/** Install `window.clipStacker.finishing` and the event listener. Returns an uninstall. */
export function installFinishingPresetApi(target: Window = window): () => void {
  const api = createFinishingPresetApi();
  const host = target as unknown as { clipStacker?: ClipStackerGlobal };
  host.clipStacker = { ...(host.clipStacker ?? {}), finishing: api };

  const onApply = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { preset?: unknown; save?: boolean; overwrite?: boolean }
      | undefined;
    const input = detail && typeof detail === 'object' && 'preset' in detail ? detail.preset : detail;
    const result = api.apply(input, { save: Boolean(detail?.save), overwrite: Boolean(detail?.overwrite) });
    target.dispatchEvent(new CustomEvent(FINISHING_PRESET_RESULT_EVENT, { detail: result }));
  };
  target.addEventListener(APPLY_FINISHING_PRESET_EVENT, onApply);
  return () => {
    target.removeEventListener(APPLY_FINISHING_PRESET_EVENT, onApply);
    if (host.clipStacker?.finishing === api) delete host.clipStacker.finishing;
  };
}
