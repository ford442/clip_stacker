import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import committedSchema from '../../docs/finishing-preset.schema.json';
import {
  DEFAULT_FINISHING,
  normalizeFinishingSettings,
  type FinishingSettings,
} from './finishing';
import {
  BUILT_IN_FINISHING_PRESETS,
  FINISHING_PASS_KEYS,
  FINISHING_PASS_SPECS,
  FINISHING_PRESET_SCHEMA_ID,
  finishingPresetAgentBrief,
  finishingPresetJsonSchema,
  parseFinishingPreset,
  presetDocumentFromFinishing,
  presetDocumentToJson,
  resolvePresetFinishing,
  summarizePreset,
  validateFinishingObject,
} from './finishingPresets';
import { identityCurves } from './curves';

/** A stack with every optional field of every pass set. */
function maximalStack(): FinishingSettings {
  return normalizeFinishingSettings({
    ...DEFAULT_FINISHING,
    noiseReduction: { ...DEFAULT_FINISHING.noiseReduction!, enabled: true, quality: 'nlm' },
    sharpen: { ...DEFAULT_FINISHING.sharpen!, enabled: true, mode: 'multiscale' },
    secondaryColor: {
      enabled: true,
      amount: 1,
      grades: [
        {
          enabled: true,
          maskType: 'hue+window',
          hueCenter: 30,
          hueWidth: 40,
          hueSoftness: 10,
          windowCenterX: 0.5,
          windowCenterY: 0.5,
          windowWidth: 0.4,
          windowHeight: 0.3,
          windowRotation: 10,
          windowFeather: 0.3,
          hueShift: 5,
          satScale: 1.2,
          lumOffset: 0.05,
          satOffset: 0.02,
          invertMask: true,
        },
      ],
    },
    lut: { enabled: true, lutId: 'film', intensity: 0.5, customFileName: 'x.cube' },
    grain: {
      ...DEFAULT_FINISHING.grain!,
      enabled: true,
      quality: 'film',
      monochromeBias: 0.5,
      temporalCoherence: 0.3,
      response: { shadows: 1, midtones: 1, highlights: 0.5 },
    },
  });
}

function fieldsOf(value: unknown, path: string, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v) => fieldsOf(v, `${path}[]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(`${path}.${k}`);
      fieldsOf(v, `${path}.${k}`, out);
    }
  }
  return out;
}

describe('field specs cover the real settings', () => {
  it('every pass of FinishingSettings has a spec, in chain order', () => {
    expect(FINISHING_PASS_KEYS).toEqual(Object.keys(DEFAULT_FINISHING));
  });

  it('a saved stack with every optional field validates (no unknown fields)', () => {
    const full = maximalStack();
    const result = validateFinishingObject(full);
    expect(result.errors).toEqual([]);
    // And every field it has is described by a spec (guards future fields).
    expect(fieldsOf(full, 'finishing').length).toBeGreaterThan(100);
    expect(validateFinishingObject(normalizeFinishingSettings(undefined)).ok).toBe(true);
  });
});

describe('parseFinishingPreset', () => {
  const minimal = (finishing: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ schema: FINISHING_PRESET_SCHEMA_ID, version: 1, name: 'Test', finishing, ...extra });

  it('accepts a full document and a bare stack', () => {
    const doc = parseFinishingPreset(minimal({ grain: { enabled: true, amount: 0.3 } }));
    expect(doc.ok && doc.preset.name).toBe('Test');
    expect(doc.ok && doc.preset.apply).toBe('replace');
    const bare = parseFinishingPreset({ bloom: { enabled: true, amount: 0.4 } });
    expect(bare.ok).toBe(true);
    expect(bare.ok && bare.warnings[0]).toMatch(/treated as a full stack/);
  });

  it('reports bad JSON clearly', () => {
    const r = parseFinishingPreset('{"finishing": {');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/^Not valid JSON/);
    expect(parseFinishingPreset('   ')).toEqual({ ok: false, errors: ['The preset is empty.'] });
    expect(parseFinishingPreset('[1,2]').ok).toBe(false);
  });

  it('rejects unknown passes and fields with the allowed list', () => {
    const r = parseFinishingPreset(minimal({ grian: { enabled: true } }));
    expect(!r.ok && r.errors[0]).toMatch(/finishing\.grian is not a finishing pass \(allowed: noiseReduction/);
    const f = parseFinishingPreset(minimal({ grain: { ammount: 0.3 } }));
    expect(!f.ok && f.errors[0]).toMatch(/finishing\.grain\.ammount is not a known setting/);
  });

  it('reports wrong types and out-of-range numbers with their path', () => {
    const r = parseFinishingPreset(
      minimal({
        sharpen: { enabled: 'yes', amount: 3, mode: 'ultra' },
        primaryColor: { lift: [0, 0] },
        bloom: { tint: [1, 1, 9] },
      }),
    );
    expect(r.ok).toBe(false);
    const errors = !r.ok ? r.errors : [];
    expect(errors).toContain('finishing.sharpen.enabled must be true or false.');
    expect(errors).toContain('finishing.sharpen.amount is 3; it must be between 0 and 1.');
    expect(errors.some((e) => e.startsWith('finishing.sharpen.mode must be one of "classic"'))).toBe(true);
    expect(errors).toContain('finishing.primaryColor.lift must be an array of 3 numbers [r, g, b].');
    expect(errors).toContain('finishing.bloom.tint[2] is 9; it must be between 0 and 2.');
  });

  it('checks document fields, version and cross-field rules', () => {
    expect(parseFinishingPreset(minimal({}, { schema: 'other' })).ok).toBe(false);
    const newer = parseFinishingPreset(minimal({}, { version: 2 }));
    expect(!newer.ok && newer.errors[0]).toMatch(/version 2; this app reads version 1/);
    expect(parseFinishingPreset(minimal({}, { apply: 'add' })).ok).toBe(false);
    expect(parseFinishingPreset(minimal({}, { colour: 1 })).ok).toBe(false);
    expect(parseFinishingPreset(JSON.stringify({ name: 'x' })).ok).toBe(false);
    const levels = parseFinishingPreset(minimal({ curves: { levels: { inBlack: 0.6, inWhite: 0.4 } } }));
    expect(!levels.ok && levels.errors[0]).toMatch(/inWhite must be greater than inBlack/);
    const knot = parseFinishingPreset(minimal({ curves: { curves: { master: [{ x: 0, y: 0 }] } } }));
    expect(!knot.ok && knot.errors[0]).toMatch(/needs at least 2 knots/);
  });

  it('requires and checks embedded .cube text for a custom LUT', () => {
    const missing = parseFinishingPreset(minimal({ lut: { enabled: true, lutId: 'custom' } }));
    expect(!missing.ok && missing.errors[0]).toMatch(/customCubeText is required/);
    const bad = parseFinishingPreset(minimal({ lut: { enabled: true, lutId: 'custom', customCubeText: 'nonsense' } }));
    expect(!bad.ok && bad.errors[0]).toMatch(/not a valid \.cube LUT/);
    const cube = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n');
    expect(parseFinishingPreset(minimal({ lut: { enabled: true, lutId: 'custom', customCubeText: cube } })).ok).toBe(true);
  });
});

describe('applying presets', () => {
  const current = normalizeFinishingSettings({
    ...DEFAULT_FINISHING,
    sharpen: { ...DEFAULT_FINISHING.sharpen!, enabled: true, amount: 0.5 },
    grain: { ...DEFAULT_FINISHING.grain!, enabled: true, amount: 0.2, size: 0.8 },
  });

  it('replace: the preset is the stack (omitted passes off, missing fields default)', () => {
    const next = resolvePresetFinishing({ apply: 'replace', finishing: { bloom: { enabled: true, amount: 0.3 } } }, current);
    expect(next.bloom?.enabled).toBe(true);
    expect(next.bloom?.radius).toBe(DEFAULT_FINISHING.bloom?.radius);
    expect(next.sharpen?.enabled).toBe(false);
    expect(next.grain?.enabled).toBe(false);
  });

  it('merge: only the listed passes change, deep-merged', () => {
    const next = resolvePresetFinishing({ apply: 'merge', finishing: { grain: { amount: 0.6 } } }, current);
    expect(next.grain?.amount).toBe(0.6);
    expect(next.grain?.size).toBe(0.8);
    expect(next.grain?.enabled).toBe(true);
    expect(next.sharpen).toEqual(current.sharpen);
  });

  it('a saved stack round-trips through export → parse → apply exactly', () => {
    const full = maximalStack();
    const doc = presetDocumentFromFinishing('Everything', full);
    const parsed = parseFinishingPreset(presetDocumentToJson(doc));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(resolvePresetFinishing(parsed.preset, DEFAULT_FINISHING)).toEqual(full);
  });
});

describe('built-in presets', () => {
  it('are valid documents with distinct names that switch something on', () => {
    const names = new Set<string>();
    for (const preset of BUILT_IN_FINISHING_PRESETS) {
      const parsed = parseFinishingPreset(presetDocumentToJson(preset));
      expect(parsed.ok, preset.name).toBe(true);
      expect(summarizePreset(preset)).not.toMatch(/every pass off/);
      names.add(preset.name.toLowerCase());
    }
    expect(names.size).toBe(BUILT_IN_FINISHING_PRESETS.length);
    expect([...names]).toEqual(['clean', 'film look', 'high contrast', 'soft']);
  });

  it('Film look leaves identity channel curves untouched', () => {
    const film = resolvePresetFinishing(BUILT_IN_FINISHING_PRESETS[1], DEFAULT_FINISHING);
    expect(film.curves?.curves.red).toEqual(identityCurves().red);
  });
});

describe('JSON Schema for agents', () => {
  it('describes every pass with closed objects', () => {
    const schema = finishingPresetJsonSchema() as {
      properties: { finishing: { properties: Record<string, { additionalProperties: boolean; properties: object }> } };
    };
    const passes = schema.properties.finishing.properties;
    expect(Object.keys(passes)).toEqual(FINISHING_PASS_KEYS);
    for (const key of FINISHING_PASS_KEYS) {
      expect(passes[key].additionalProperties).toBe(false);
      const spec = FINISHING_PASS_SPECS[key];
      expect(spec.type).toBe('object');
      if (spec.type === 'object') expect(Object.keys(passes[key].properties)).toEqual(Object.keys(spec.fields));
    }
  });

  it('the committed docs/finishing-preset.schema.json is up to date', () => {
    // Regenerate after changing a field spec:
    //   UPDATE_FINISHING_SCHEMA=1 npx vitest --run src/utils/finishingPresets.test.ts
    if (process.env.UPDATE_FINISHING_SCHEMA) {
      writeFileSync(
        resolve(process.cwd(), 'docs/finishing-preset.schema.json'),
        `${JSON.stringify(finishingPresetJsonSchema(), null, 2)}\n`,
      );
      return;
    }
    expect(committedSchema).toEqual(finishingPresetJsonSchema());
  });

  it('the agent brief carries instructions, an example and the schema', () => {
    const brief = finishingPresetAgentBrief();
    expect(brief).toMatch(/"apply": "merge"/);
    expect(brief).toContain('"name": "Film look"');
    expect(brief).toContain('"$schema": "https://json-schema.org/draft/2020-12/schema"');
  });
});
