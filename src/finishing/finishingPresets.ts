/**
 * Finishing presets — a whole `FinishingSettings` stack saved under a name,
 * shipped as a built-in, or produced by an AI agent as JSON.
 *
 * A preset document:
 *
 *   {
 *     "schema": "clip_stacker.finishing-preset",
 *     "version": 1,
 *     "name": "Night city glow",
 *     "description": "optional",
 *     "apply": "replace",            // or "merge"
 *     "finishing": { "curves": { … }, "bloom": { … } }
 *   }
 *
 * `finishing` uses the same shape a saved project stores, so presets stay
 * compatible with project load: every pass and every field is optional and
 * missing fields take the pass defaults. With `apply: "replace"` (default)
 * the preset *is* the stack — passes it omits are switched off. With
 * `"merge"` only the passes it names change, deep-merged onto the current
 * stack (handy for an agent that only wants to "add some grain").
 *
 * Validation is strict and all-or-nothing: unknown keys, wrong types and
 * out-of-range numbers are reported with their JSON path and nothing is
 * applied. Only a valid document is normalized (`normalizeFinishingSettings`).
 * The same field specs (`finishingPresetSpecs.ts`) generate the JSON Schema
 * agents are given (`finishingPresetJsonSchema`), so the schema and the
 * validator cannot disagree.
 */

import {
  DEFAULT_FINISHING,
  normalizeFinishingSettings,
  type FinishingSettings,
} from './finishing';
import { parseCubeLut } from './lut';
import { FINISHING_PASS_KEYS, FINISHING_PASS_SPECS, type FieldSpec } from './finishingPresetSpecs';

export {
  FINISHING_PASS_KEYS,
  FINISHING_PASS_SPECS,
  FINISHING_PRESET_CUBE_MAX_CHARS,
} from './finishingPresetSpecs';

export const FINISHING_PRESET_SCHEMA_ID = 'clip_stacker.finishing-preset';
export const FINISHING_PRESET_VERSION = 1;
export const FINISHING_PRESET_NAME_MAX = 80;

export type FinishingPresetApplyMode = 'replace' | 'merge';

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** A preset's stack: any pass, any field — missing ones take defaults. */
export type FinishingPresetStack = DeepPartial<FinishingSettings>;

export interface FinishingPresetDocument {
  schema: typeof FINISHING_PRESET_SCHEMA_ID;
  version: number;
  name: string;
  description?: string;
  apply: FinishingPresetApplyMode;
  /** The (partial) stack exactly as written; normalized when applied. */
  finishing: FinishingPresetStack;
}

// ---------------------------------------------------------------------------
// Validation

export interface PresetValidationResult {
  ok: boolean;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateField(value: unknown, spec: FieldSpec, path: string, errors: string[]): void {
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be true or false.`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path} must be a number.`);
      } else if (value < spec.min || value > spec.max) {
        errors.push(`${path} is ${value}; it must be between ${spec.min} and ${spec.max}.`);
      }
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push(`${path} must be one of ${spec.values.map((v) => `"${v}"`).join(', ')}.`);
      }
      return;
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string.`);
      else if (value.length > spec.maxLength) {
        errors.push(`${path} is too long (${value.length} > ${spec.maxLength} characters).`);
      }
      return;
    case 'rgb':
      if (!Array.isArray(value) || value.length !== 3) {
        errors.push(`${path} must be an array of 3 numbers [r, g, b].`);
        return;
      }
      value.forEach((c, i) =>
        validateField(c, { type: 'number', min: spec.min, max: spec.max, description: '' }, `${path}[${i}]`, errors),
      );
      return;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array.`);
        return;
      }
      if (value.length > spec.maxItems) {
        errors.push(`${path} has ${value.length} items; at most ${spec.maxItems} are allowed.`);
      }
      value.forEach((item, i) => validateField(item, spec.items, `${path}[${i}]`, errors));
      return;
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path} must be an object.`);
        return;
      }
      const allowed = Object.keys(spec.fields);
      for (const [key, v] of Object.entries(value)) {
        const child = spec.fields[key];
        if (!child) {
          errors.push(`${path}.${key} is not a known setting (allowed: ${allowed.join(', ')}).`);
          continue;
        }
        validateField(v, child, `${path}.${key}`, errors);
      }
    }
  }
}

/** Cross-field checks the per-field specs cannot express. */
function validateSemantics(finishing: Record<string, unknown>, errors: string[]): void {
  const curves = finishing.curves as Record<string, unknown> | undefined;
  const levels = curves?.levels as Record<string, unknown> | undefined;
  if (
    typeof levels?.inBlack === 'number' &&
    typeof levels?.inWhite === 'number' &&
    levels.inWhite <= levels.inBlack
  ) {
    errors.push('finishing.curves.levels.inWhite must be greater than inBlack.');
  }
  const channels = curves?.curves as Record<string, unknown> | undefined;
  for (const [channel, pts] of Object.entries(channels ?? {})) {
    if (Array.isArray(pts) && pts.length < 2) {
      errors.push(`finishing.curves.curves.${channel} needs at least 2 knots.`);
    }
  }
  const lut = finishing.lut as Record<string, unknown> | undefined;
  if (lut?.lutId === 'custom') {
    if (typeof lut.customCubeText !== 'string' || !lut.customCubeText.trim()) {
      errors.push("finishing.lut.customCubeText is required when lutId is 'custom'.");
    } else {
      try {
        parseCubeLut(lut.customCubeText);
      } catch (e) {
        errors.push(`finishing.lut.customCubeText is not a valid .cube LUT: ${(e as Error).message}`);
      }
    }
  }
}

export function validateFinishingObject(value: unknown, path = 'finishing'): PresetValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: [`${path} must be an object of finishing passes.`] };
  }
  for (const [key, pass] of Object.entries(value)) {
    const spec = FINISHING_PASS_SPECS[key as keyof FinishingSettings];
    if (!spec) {
      errors.push(`${path}.${key} is not a finishing pass (allowed: ${FINISHING_PASS_KEYS.join(', ')}).`);
      continue;
    }
    validateField(pass, spec, `${path}.${key}`, errors);
  }
  if (errors.length === 0) validateSemantics(value, errors);
  return { ok: errors.length === 0, errors };
}

const DOCUMENT_KEYS = ['schema', 'version', '$schema', 'name', 'description', 'apply', 'finishing'];

export type ParsePresetResult =
  | { ok: true; preset: FinishingPresetDocument; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Parse a preset from JSON text or an already-parsed value. Accepts a full
 * preset document, or a bare finishing object (`{ "grain": { … } }`), which
 * is treated as `apply: "replace"`.
 */
export function parseFinishingPreset(input: unknown, fallbackName = 'Imported preset'): ParsePresetResult {
  let value = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { ok: false, errors: ['The preset is empty.'] };
    try {
      value = JSON.parse(text);
    } catch (e) {
      return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
    }
  }
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['A finishing preset must be a JSON object.'] };
  }

  const keys = Object.keys(value);
  const isBareStack = keys.length > 0 && keys.every((k) => k in FINISHING_PASS_SPECS);
  const warnings: string[] = [];
  if (isBareStack) {
    const check = validateFinishingObject(value);
    if (!check.ok) return { ok: false, errors: check.errors };
    warnings.push('No preset wrapper — treated as a full stack (apply: "replace").');
    return {
      ok: true,
      warnings,
      preset: {
        schema: FINISHING_PRESET_SCHEMA_ID,
        version: FINISHING_PRESET_VERSION,
        name: fallbackName,
        apply: 'replace',
        finishing: value as FinishingPresetStack,
      },
    };
  }

  const errors: string[] = [];
  for (const key of keys) {
    if (!DOCUMENT_KEYS.includes(key)) {
      errors.push(`"${key}" is not a preset field (allowed: ${DOCUMENT_KEYS.join(', ')}).`);
    }
  }
  if (value.schema !== undefined && value.schema !== FINISHING_PRESET_SCHEMA_ID) {
    errors.push(`"schema" must be "${FINISHING_PRESET_SCHEMA_ID}".`);
  }
  if (value.version !== undefined) {
    if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
      errors.push('"version" must be a positive integer.');
    } else if (value.version > FINISHING_PRESET_VERSION) {
      errors.push(
        `This preset is version ${value.version}; this app reads version ${FINISHING_PRESET_VERSION}. Update the app.`,
      );
    }
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > FINISHING_PRESET_NAME_MAX)) {
    errors.push(`"name" must be a string of at most ${FINISHING_PRESET_NAME_MAX} characters.`);
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    errors.push('"description" must be a string.');
  }
  if (value.apply !== undefined && value.apply !== 'replace' && value.apply !== 'merge') {
    errors.push('"apply" must be "replace" or "merge".');
  }
  if (value.finishing === undefined) {
    errors.push('"finishing" is required: an object of finishing passes.');
  } else {
    errors.push(...validateFinishingObject(value.finishing).errors);
  }
  if (errors.length > 0) return { ok: false, errors };

  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : fallbackName;
  return {
    ok: true,
    warnings,
    preset: {
      schema: FINISHING_PRESET_SCHEMA_ID,
      version: FINISHING_PRESET_VERSION,
      name,
      ...(typeof value.description === 'string' && value.description.trim()
        ? { description: value.description.trim() }
        : {}),
      apply: value.apply === 'merge' ? 'merge' : 'replace',
      finishing: value.finishing as FinishingPresetStack,
    },
  };
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

/** The full, normalized stack a preset produces over `current`. */
export function resolvePresetFinishing(
  preset: Pick<FinishingPresetDocument, 'apply' | 'finishing'>,
  current: FinishingSettings,
): FinishingSettings {
  if (preset.apply === 'merge') {
    return normalizeFinishingSettings(deepMerge(current, preset.finishing) as Partial<FinishingSettings>);
  }
  return normalizeFinishingSettings(preset.finishing as Partial<FinishingSettings>);
}

/** A preset document capturing `finishing` exactly (every pass, normalized). */
export function presetDocumentFromFinishing(
  name: string,
  finishing: FinishingSettings,
  description?: string,
): FinishingPresetDocument {
  return {
    schema: FINISHING_PRESET_SCHEMA_ID,
    version: FINISHING_PRESET_VERSION,
    name: name.trim().slice(0, FINISHING_PRESET_NAME_MAX) || 'Untitled preset',
    ...(description?.trim() ? { description: description.trim() } : {}),
    apply: 'replace',
    finishing: structuredClone(normalizeFinishingSettings(finishing)),
  };
}

export function presetDocumentToJson(doc: FinishingPresetDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Short summary for UI: which passes the preset switches on. */
export function summarizePreset(doc: Pick<FinishingPresetDocument, 'apply' | 'finishing'>): string {
  const on = FINISHING_PASS_KEYS.filter(
    (k) => (doc.finishing[k] as { enabled?: boolean } | undefined)?.enabled === true,
  );
  const verb = doc.apply === 'merge' ? 'Merges' : 'Sets';
  return on.length === 0 ? `${verb} every pass off` : `${verb} ${on.join(', ')} on`;
}

// ---------------------------------------------------------------------------
// JSON Schema (draft 2020-12) for agents — generated from the field specs.

type JsonSchema = Record<string, unknown>;

function fieldToJsonSchema(spec: FieldSpec): JsonSchema {
  switch (spec.type) {
    case 'boolean':
      return { type: 'boolean', description: spec.description };
    case 'number':
      return { type: 'number', minimum: spec.min, maximum: spec.max, description: spec.description };
    case 'enum':
      return { enum: [...spec.values], description: spec.description };
    case 'string':
      return { type: 'string', maxLength: spec.maxLength, description: spec.description };
    case 'rgb':
      return {
        type: 'array',
        items: { type: 'number', minimum: spec.min, maximum: spec.max },
        minItems: 3,
        maxItems: 3,
        description: spec.description,
      };
    case 'array':
      return { type: 'array', items: fieldToJsonSchema(spec.items), maxItems: spec.maxItems, description: spec.description };
    case 'object':
      return {
        type: 'object',
        additionalProperties: false,
        description: spec.description,
        properties: Object.fromEntries(
          Object.entries(spec.fields).map(([k, v]) => [k, fieldToJsonSchema(v)]),
        ),
      };
  }
}

export function finishingPresetJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:clip-stacker:finishing-preset:v1',
    title: 'Clip Stacker finishing preset',
    description:
      'A finishing stack for Clip Stacker. Every pass and field is optional; missing fields take defaults. ' +
      'apply "replace" (default) makes this the whole stack (omitted passes are switched off); ' +
      '"merge" changes only the passes listed. Pass order: ' +
      FINISHING_PASS_KEYS.join(' → ') +
      '.',
    type: 'object',
    additionalProperties: false,
    required: ['finishing'],
    properties: {
      $schema: { type: 'string' },
      schema: { const: FINISHING_PRESET_SCHEMA_ID },
      version: { const: FINISHING_PRESET_VERSION },
      name: { type: 'string', maxLength: FINISHING_PRESET_NAME_MAX },
      description: { type: 'string' },
      apply: { enum: ['replace', 'merge'], default: 'replace' },
      finishing: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          FINISHING_PASS_KEYS.map((k) => [k, fieldToJsonSchema(FINISHING_PASS_SPECS[k])]),
        ),
      },
    },
  };
}

/** Clipboard text for an agent: what to produce, the schema, and an example. */
export function finishingPresetAgentBrief(): string {
  return [
    'Produce a Clip Stacker finishing preset as one JSON object matching this JSON Schema.',
    'Only include the passes and fields you want; omitted fields use defaults.',
    'Use "apply": "merge" to change only the listed passes, or "replace" (default) to set the whole stack.',
    '',
    'Example:',
    presetDocumentToJson(BUILT_IN_FINISHING_PRESETS[1]),
    'Schema:',
    JSON.stringify(finishingPresetJsonSchema(), null, 2),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Built-in starter presets (validated by the same parser in tests).

const doc = (name: string, description: string, finishing: FinishingPresetStack): FinishingPresetDocument => ({
  schema: FINISHING_PRESET_SCHEMA_ID,
  version: FINISHING_PRESET_VERSION,
  name,
  description,
  apply: 'replace',
  finishing,
});

export const BUILT_IN_FINISHING_PRESETS: readonly FinishingPresetDocument[] = [
  doc('Clean', 'Edge-aware denoise and gentle, halo-free sharpening.', {
    noiseReduction: { ...DEFAULT_FINISHING.noiseReduction!, enabled: true, quality: 'high', spatialStrength: 0.4, spatialRadius: 2 },
    sharpen: { ...DEFAULT_FINISHING.sharpen!, enabled: true, mode: 'edge', amount: 0.25, radius: 1.2, threshold: 0.02 },
  }),
  doc('Film look', 'Soft S-curve, warm highlights, subtle bloom and 35mm film grain.', {
    curves: {
      enabled: true,
      amount: 1,
      levels: { inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0.03, outWhite: 0.97 },
      curves: {
        master: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.21 },
          { x: 0.75, y: 0.8 },
          { x: 1, y: 1 },
        ],
        red: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        green: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        blue: [
          { x: 0, y: 0.02 },
          { x: 1, y: 0.95 },
        ],
      },
    },
    bloom: { enabled: true, amount: 0.2, mode: 'bloom', threshold: 0.75, softness: 0.6, radius: 0.35, tint: [1, 0.85, 0.7] },
    grain: {
      ...DEFAULT_FINISHING.grain!,
      enabled: true,
      quality: 'film',
      amount: 0.32,
      size: 0.4,
      softness: 0.45,
      monochromeBias: 0.75,
      temporalCoherence: 0.2,
      response: { shadows: 0.9, midtones: 1, highlights: 0.6 },
    },
  }),
  doc('High contrast', 'Strong S-curve, richer colour and multi-scale detail.', {
    primaryColor: { ...DEFAULT_FINISHING.primaryColor!, enabled: true, contrast: 1.12, saturation: 1.12 },
    curves: {
      enabled: true,
      amount: 1,
      levels: { inBlack: 0.02, inWhite: 0.98, gamma: 1, outBlack: 0, outWhite: 1 },
      curves: {
        master: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.15 },
          { x: 0.75, y: 0.86 },
          { x: 1, y: 1 },
        ],
        red: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        green: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        blue: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    },
    sharpen: { ...DEFAULT_FINISHING.sharpen!, enabled: true, mode: 'multiscale', amount: 0.3, radius: 1.5, midtoneDetail: 0.25 },
  }),
  doc('Soft', 'Lifted matte blacks, gentle desaturation, light glow and fine grain.', {
    primaryColor: { ...DEFAULT_FINISHING.primaryColor!, enabled: true, saturation: 0.92, contrast: 0.95 },
    curves: {
      enabled: true,
      amount: 1,
      levels: { inBlack: 0, inWhite: 1, gamma: 1.05, outBlack: 0.06, outWhite: 0.96 },
      curves: {
        master: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        red: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        green: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        blue: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    },
    bloom: { enabled: true, amount: 0.25, mode: 'bloom', threshold: 0.6, softness: 0.8, radius: 0.5, tint: [1, 1, 1] },
    grain: { ...DEFAULT_FINISHING.grain!, enabled: true, quality: 'film', amount: 0.15, size: 0.2, softness: 0.6, monochromeBias: 0.9 },
  }),
];
