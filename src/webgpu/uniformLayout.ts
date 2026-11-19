/**
 * Uniform-buffer contracts from one declarative spec.
 *
 * A pass used to keep three hand-maintained copies of its uniform layout: the
 * WGSL `struct`, a TS packer writing flat float slots, and a test pinning the
 * slot numbers against the shader text. {@link defineUniformLayout} derives
 * all of them from a field list:
 *
 * - `wgsl` — the `struct` text, spliced into the shader source in place of a
 *   `// @uniforms <StructName>` line ({@link spliceUniformStructs}), the way
 *   transition bodies are spliced into `transitions/shaderTemplate.ts`;
 * - `pack(values)` — a typed packer (`f32` / `u32` → number, `vecN` → VecN,
 *   arrays → a list of them) writing the WGSL memory layout into a
 *   `Float32Array` (`u32` through a `Uint32Array` view of the same buffer);
 * - `byteSize` / `floats` / `offsets` — sizes and float offsets with the WGSL
 *   alignment rules (vec2 align 8, vec3 / vec4 / arrays align 16, the struct
 *   rounded to 16).
 *
 * Fields whose name starts with `_` are explicit padding: they are not part of
 * the values and always pack as 0. They are kept explicit (rather than
 * implied by alignment) so the struct reads the same as before the spec, and
 * so a field appended after a `vec2` lands where the old layout put it.
 *
 * The table test `uniformLayout.test.ts` checks every spec's size and offsets
 * and that each assembled shader contains its emitted struct.
 */

import type { Vec2, Vec3, Vec4 } from '../types/tuples';

export type UniformFieldType = 'f32' | 'u32' | 'vec2' | 'vec3' | 'vec4';

export interface UniformFieldSpec {
  readonly name: string;
  readonly type: UniformFieldType;
  /**
   * Array length: the field is `array<vec4<f32>, count>`. Only `vec4` arrays
   * are allowed, because uniform-space arrays have a 16-byte element stride.
   */
  readonly count?: number;
  /** One-line comment emitted above the field in the WGSL struct. */
  readonly doc?: string;
}

type ScalarValue<T extends UniformFieldType> = T extends 'f32' | 'u32'
  ? number
  : T extends 'vec2'
    ? Vec2
    : T extends 'vec3'
      ? Vec3
      : Vec4;

type FieldValue<F extends UniformFieldSpec> = F extends { readonly count: number }
  ? readonly Vec4[]
  : ScalarValue<F['type']>;

/** The values `pack` takes: every non-padding field by name. */
export type UniformValues<Fs extends readonly UniformFieldSpec[]> = {
  readonly [F in Fs[number] as F['name'] extends `_${string}` ? never : F['name']]: FieldValue<F>;
};

/** One field with its resolved placement (offsets in bytes). */
export interface UniformFieldPlacement {
  readonly name: string;
  readonly type: UniformFieldType;
  readonly count: number | undefined;
  readonly byteOffset: number;
  readonly byteSize: number;
}

export interface UniformLayout<Fs extends readonly UniformFieldSpec[]> {
  /** The WGSL struct name. */
  readonly structName: string;
  readonly fields: Fs;
  readonly placements: readonly UniformFieldPlacement[];
  /** Float (4-byte word) offset of every field, padding included. */
  readonly offsets: { readonly [K in Fs[number]['name']]: number };
  /** Uniform-buffer size in bytes: the struct size rounded up to 16. */
  readonly byteSize: number;
  /** `byteSize / 4`: the `Float32Array` length `pack` fills. */
  readonly floats: number;
  /** The WGSL `struct … { … };` text. */
  readonly wgsl: string;
  /**
   * Write `values` at float `offset` of `out` (a fresh buffer when omitted)
   * and return `out`. Writes every field, padding as 0 and array tails past
   * the given elements as 0; it does not touch the struct's tail padding.
   */
  pack(values: UniformValues<Fs>, out?: Float32Array, offset?: number): Float32Array;
}

const TYPE_ALIGN: Record<UniformFieldType, number> = { f32: 4, u32: 4, vec2: 8, vec3: 16, vec4: 16 };
const TYPE_SIZE: Record<UniformFieldType, number> = { f32: 4, u32: 4, vec2: 8, vec3: 12, vec4: 16 };
const TYPE_WGSL: Record<UniformFieldType, string> = {
  f32: 'f32',
  u32: 'u32',
  vec2: 'vec2<f32>',
  vec3: 'vec3<f32>',
  vec4: 'vec4<f32>',
};
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function roundUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

function place(fields: readonly UniformFieldSpec[]): { placements: UniformFieldPlacement[]; end: number } {
  const placements: UniformFieldPlacement[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (const field of fields) {
    if (!IDENT.test(field.name)) throw new Error(`uniform field name "${field.name}" is not a WGSL identifier`);
    if (seen.has(field.name)) throw new Error(`uniform field "${field.name}" is declared twice`);
    seen.add(field.name);
    const count = field.count;
    if (count !== undefined && (field.type !== 'vec4' || !Number.isInteger(count) || count < 1)) {
      throw new Error(`uniform array "${field.name}" must be vec4 with a positive integer count`);
    }
    const align = count === undefined ? TYPE_ALIGN[field.type] : 16;
    const byteSize = count === undefined ? TYPE_SIZE[field.type] : 16 * count;
    const byteOffset = roundUp(cursor, align);
    placements.push({ name: field.name, type: field.type, count, byteOffset, byteSize });
    cursor = byteOffset + byteSize;
  }
  return { placements, end: cursor };
}

function emitWgsl(structName: string, fields: readonly UniformFieldSpec[]): string {
  const lines = [`struct ${structName} {`];
  for (const field of fields) {
    if (field.doc) lines.push(`  // ${field.doc}`);
    const type = field.count === undefined ? TYPE_WGSL[field.type] : `array<vec4<f32>, ${field.count}>`;
    lines.push(`  ${field.name}: ${type},`);
  }
  lines.push('};');
  return lines.join('\n');
}

type Writer = (values: Readonly<Record<string, unknown>>, f32: Float32Array, u32: Uint32Array, base: number) => void;

function writerFor(p: UniformFieldPlacement): Writer {
  const at = p.byteOffset / 4;
  const padding = p.name.startsWith('_');
  const words = p.byteSize / 4;
  if (padding) {
    return (_values, f32, _u32, base) => {
      f32.fill(0, base + at, base + at + words);
    };
  }
  const name = p.name;
  if (p.type === 'u32') {
    return (values, _f32, u32, base) => {
      u32[base + at] = values[name] as number;
    };
  }
  if (p.type === 'f32') {
    return (values, f32, _u32, base) => {
      f32[base + at] = values[name] as number;
    };
  }
  if (p.count !== undefined) {
    const count = p.count;
    return (values, f32, _u32, base) => {
      let n = 0;
      for (const item of values[name] as readonly Vec4[]) {
        if (n >= count) break;
        f32.set(item, base + at + n * 4);
        n++;
      }
      f32.fill(0, base + at + n * 4, base + at + words);
    };
  }
  return (values, f32, _u32, base) => {
    f32.set(values[name] as readonly number[], base + at);
  };
}

/**
 * Build a {@link UniformLayout} from a WGSL struct name and its fields, in
 * declaration order. Declare `fields` inline (or `as const`) so `pack` gets
 * typed values.
 */
export function defineUniformLayout<const Fs extends readonly UniformFieldSpec[]>(
  structName: string,
  fields: Fs,
): UniformLayout<Fs> {
  if (!IDENT.test(structName)) throw new Error(`uniform struct name "${structName}" is not a WGSL identifier`);
  const { placements, end } = place(fields);
  const byteSize = roundUp(Math.max(end, 16), 16);
  const floats = byteSize / 4;
  const offsets: Record<string, number> = {};
  for (const p of placements) offsets[p.name] = p.byteOffset / 4;
  const writers = placements.map(writerFor);
  const hasU32 = placements.some((p) => p.type === 'u32');

  return {
    structName,
    fields,
    placements,
    offsets: offsets as UniformLayout<Fs>['offsets'],
    byteSize,
    floats,
    wgsl: emitWgsl(structName, fields),
    pack(values, out = new Float32Array(floats), offset = 0) {
      if (out.length < offset + Math.ceil(end / 4)) {
        throw new Error(`${structName} needs ${Math.ceil(end / 4)} floats at offset ${offset}`);
      }
      const u32 = hasU32 ? new Uint32Array(out.buffer, out.byteOffset, out.length) : EMPTY_U32;
      const record = values as Readonly<Record<string, unknown>>;
      for (const write of writers) write(record, out, u32, offset);
      return out;
    },
  };
}

const EMPTY_U32 = new Uint32Array(0);

/** The placeholder line a shader carries where a spec's struct goes. */
export function uniformPlaceholder(structName: string): string {
  return `// @uniforms ${structName}`;
}

/**
 * Replace each layout's `// @uniforms <StructName>` line in `source` with its
 * emitted struct. Throws when a placeholder is missing or repeated, so a
 * renamed struct fails at module load instead of compiling against nothing.
 */
export function spliceUniformStructs(
  source: string,
  ...layouts: readonly Pick<UniformLayout<readonly UniformFieldSpec[]>, 'structName' | 'wgsl'>[]
): string {
  let code = source;
  for (const layout of layouts) {
    const marker = uniformPlaceholder(layout.structName);
    const line = new RegExp(`^${marker}[ \\t]*$`, 'gm');
    const hits = code.match(line)?.length ?? 0;
    if (hits !== 1) throw new Error(`shader must contain the line "${marker}" exactly once (found ${hits})`);
    code = code.replace(line, () => layout.wgsl);
  }
  return code;
}
