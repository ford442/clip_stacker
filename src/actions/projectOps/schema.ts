/**
 * JSON Schema and validation for `ProjectOp`s, both generated from
 * `PROJECT_OPS` (spec.ts). Validation is strict and path-specific (unknown
 * ops and fields are errors, as in `finishingPresets.ts`); payloads the spec
 * leaves open (bus FX, presets, captions) are checked by the op itself.
 */

import { PROJECT_OPS, type FieldSchema, type FieldSpec, type ProjectOp } from './spec';

/** The API surface version (`clipStacker.api.version`); bump on a breaking change. */
export const PROJECT_API_VERSION = 1;

type JsonSchema = Record<string, unknown>;

function fieldSchema(schema: FieldSchema, description?: string): JsonSchema {
  const base: JsonSchema = description ? { description } : {};
  switch (schema.type) {
    case 'string':
      return { ...base, type: 'string', ...(schema.enum ? { enum: [...schema.enum] } : {}), ...(schema.minLength ? { minLength: schema.minLength } : {}) };
    case 'number':
      return {
        ...base,
        type: 'number',
        ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
        ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
      };
    case 'integer':
      return { ...base, type: 'integer', ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}) };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'array':
      return { ...base, type: 'array', items: fieldSchema(schema.items), ...(schema.maxItems ? { maxItems: schema.maxItems } : {}) };
    case 'object':
      return schema.fields ? { ...base, ...objectSchema(schema.fields) } : { ...base, type: 'object' };
  }
}

function objectSchema(fields: Readonly<Record<string, FieldSpec>>, extra: Record<string, JsonSchema> = {}): JsonSchema {
  const required = Object.entries(fields).filter(([, spec]) => spec.required).map(([key]) => key);
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...extra,
      ...Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, fieldSchema(spec.schema, spec.description)])),
    },
    ...(required.length > 0 || Object.keys(extra).length > 0 ? { required: [...Object.keys(extra), ...required] } : {}),
  };
}

/** JSON Schema (2020-12) for the argument of `project.apply`: an array of ops. */
export function projectOpsJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:clip-stacker:project-ops:v${PROJECT_API_VERSION}`,
    title: 'Clip Stacker project ops',
    description:
      'Scripted edits for window.clipStacker.project.apply(ops): applied in order as one undo step, all or nothing. ' +
      'Times are seconds (startTime / time on the output timeline, trimStart / trimEnd in the clip source).',
    type: 'array',
    items: { $ref: '#/$defs/ProjectOp' },
    $defs: {
      ProjectOp: { oneOf: Object.keys(PROJECT_OPS).map((name) => ({ $ref: `#/$defs/${name}` })) },
      ...Object.fromEntries(
        Object.entries(PROJECT_OPS).map(([name, spec]) => [
          name,
          { description: spec.description, ...objectSchema(spec.fields, { op: { const: name } }) },
        ]),
      ),
    },
  };
}

function typeError(path: string, expected: string, value: unknown): string {
  const got = Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value;
  return `${path} must be ${expected} (got ${got})`;
}

function checkField(schema: FieldSchema, value: unknown, path: string, errors: string[]): void {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(typeError(path, 'a string', value));
      else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')} (got "${value}")`);
      else if (schema.minLength && value.length < schema.minLength) errors.push(`${path} must not be empty`);
      return;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(typeError(path, 'a finite number', value));
      else if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
      else if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be ≥ ${schema.minimum}`);
      else if (schema.type === 'number' && schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be ≤ ${schema.maximum}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(typeError(path, 'true or false', value));
      return;
    case 'array':
      if (!Array.isArray(value)) errors.push(typeError(path, 'an array', value));
      else value.forEach((item, i) => checkField(schema.items, item, `${path}[${i}]`, errors));
      return;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(typeError(path, 'an object', value));
      else if (schema.fields) checkObject(schema.fields, value as Record<string, unknown>, path, errors);
      return;
  }
}

function checkObject(fields: Readonly<Record<string, FieldSpec>>, value: Record<string, unknown>, path: string, errors: string[], skip: string[] = []): void {
  for (const key of Object.keys(value)) {
    if (skip.includes(key)) continue;
    if (!(key in fields)) errors.push(`${path}.${key} is not a field (allowed: ${Object.keys(fields).join(', ')})`);
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (value[key] === undefined) {
      if (spec.required) errors.push(`${path}.${key} is required`);
      continue;
    }
    checkField(spec.schema, value[key], `${path}.${key}`, errors);
  }
}

export type ValidateOpsResult = { ok: true; ops: ProjectOp[] } | { ok: false; errors: string[] };

/** Check `input` (an op, an array of ops, or their JSON) against the spec. */
export function validateProjectOps(input: unknown): ValidateOpsResult {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return { ok: false, errors: [`ops are not JSON: ${(error as Error).message}`] };
    }
  }
  const list = Array.isArray(value) ? value : [value];
  const errors: string[] = [];
  list.forEach((op, i) => {
    const path = `ops[${i}]`;
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      errors.push(typeError(path, 'an object', op));
      return;
    }
    const name = (op as { op?: unknown }).op;
    const spec = typeof name === 'string' ? PROJECT_OPS[name] : undefined;
    if (!spec) {
      errors.push(`${path}.op must be one of ${Object.keys(PROJECT_OPS).join(', ')} (got ${JSON.stringify(name)})`);
      return;
    }
    checkObject(spec.fields, op as Record<string, unknown>, path, errors, ['op']);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, ops: list as ProjectOp[] };
}
