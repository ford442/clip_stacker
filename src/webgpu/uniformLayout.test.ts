import { describe, expect, it } from 'vitest';
import { AUDIO_UNIFORM_OFFSET } from '../wasm/audioReactiveUniforms';
import { defineUniformLayout, spliceUniformStructs, uniformPlaceholder, type UniformLayout, type UniformFieldSpec } from './uniformLayout';
import {
  BLOOM_UNIFORMS,
  CHROMATIC_ABERRATION_UNIFORMS,
  CURVES_UNIFORMS,
  CURVE_KNOTS_PER_CHANNEL,
  GRAIN_UNIFORMS,
  KEY_UNIFORM_FIELDS,
  NOISE_REDUCTION_UNIFORMS,
  PREVIEW_LAYER_UNIFORMS,
  SHARPEN_UNIFORMS,
} from './uniformSpecs';
import { listAssembledShaders } from './shaderCatalog';

describe('defineUniformLayout', () => {
  const layout = defineUniformLayout('Probe', [
    { name: 'a', type: 'f32', doc: 'first' },
    { name: 'b', type: 'vec2' },
    { name: 'c', type: 'f32' },
    { name: 'd', type: 'vec3' },
    { name: 'e', type: 'u32' },
    { name: '_pad', type: 'f32' },
    { name: 'f', type: 'vec4' },
    { name: 'g', type: 'vec4', count: 3 },
    { name: 'h', type: 'f32' },
  ]);

  it('places fields with the WGSL alignment rules', () => {
    // a @0, b aligns to 8 → @2, c @4, d aligns to 16 → @8 (12 bytes), e @11,
    // _pad @12, f aligns to 16 → @16, g @20 (stride 16), h @32; size 33 → 36.
    expect(layout.offsets).toEqual({ a: 0, b: 2, c: 4, d: 8, e: 11, _pad: 12, f: 16, g: 20, h: 32 });
    expect(layout.byteSize).toBe(144);
    expect(layout.floats).toBe(36);
  });

  it('emits the struct text', () => {
    expect(layout.wgsl).toBe(
      [
        'struct Probe {',
        '  // first',
        '  a: f32,',
        '  b: vec2<f32>,',
        '  c: f32,',
        '  d: vec3<f32>,',
        '  e: u32,',
        '  _pad: f32,',
        '  f: vec4<f32>,',
        '  g: array<vec4<f32>, 3>,',
        '  h: f32,',
        '};',
      ].join('\n'),
    );
  });

  it('packs typed values, u32 bit-exact, padding and array tails as 0', () => {
    const out = new Float32Array(40).fill(-7);
    layout.pack(
      { a: 1, b: [2, 3], c: 4, d: [5, 6, 7], e: 0xffffffff, f: [8, 9, 10, 11], g: [[12, 13, 14, 15]], h: 16 },
      out,
      2,
    );
    const words = new Uint32Array(out.buffer);
    expect(out[2]).toBe(1);
    expect(Array.from(out.slice(4, 6))).toEqual([2, 3]);
    expect(out[3]).toBe(-7); // alignment gap before b is left alone
    expect(Array.from(out.slice(10, 13))).toEqual([5, 6, 7]);
    expect(words[13]).toBe(0xffffffff);
    expect(out[14]).toBe(0);
    expect(Array.from(out.slice(18, 22))).toEqual([8, 9, 10, 11]);
    expect(Array.from(out.slice(22, 26))).toEqual([12, 13, 14, 15]);
    expect(Array.from(out.slice(26, 34))).toEqual(new Array(8).fill(0));
    expect(out[34]).toBe(16);
    expect(out[35]).toBe(-7); // struct tail padding is not written
  });

  it('types its values from the spec', () => {
    const small = defineUniformLayout('Small', [
      { name: 'x', type: 'f32' },
      { name: 'v', type: 'vec2' },
      { name: '_pad', type: 'vec4' },
    ]);
    // Type-level only (typecheck fails if an @ts-expect-error stops erroring).
    const typeChecks = () => {
      // @ts-expect-error a missing field
      small.pack({ x: 1 });
      // @ts-expect-error a vec2 is two numbers
      small.pack({ x: 1, v: [1, 2, 3] });
      // @ts-expect-error padding is not a value
      small.pack({ x: 1, v: [1, 2], _pad: [0, 0, 0, 0] });
    };
    expect(typeof typeChecks).toBe('function');
    expect(Array.from(small.pack({ x: 1, v: [2, 3] }))).toEqual([1, 0, 2, 3, 0, 0, 0, 0]);
    expect(small.floats).toBe(8);
  });

  it('rejects arrays it cannot lay out and duplicate names', () => {
    expect(() => defineUniformLayout('Bad', [{ name: 'a', type: 'f32', count: 4 }])).toThrow(/vec4/);
    expect(() =>
      defineUniformLayout('Bad', [
        { name: 'a', type: 'f32' },
        { name: 'a', type: 'f32' },
      ]),
    ).toThrow(/twice/);
  });

  it('refuses a buffer too small for the fields', () => {
    expect(() => layout.pack({ a: 0, b: [0, 0], c: 0, d: [0, 0, 0], e: 0, f: [0, 0, 0, 0], g: [], h: 0 }, new Float32Array(8))).toThrow(/needs/);
  });
});

describe('spliceUniformStructs', () => {
  const layout = defineUniformLayout('S', [{ name: 'x', type: 'f32' }]);

  it('replaces the placeholder line with the struct', () => {
    expect(spliceUniformStructs(`a\n${uniformPlaceholder('S')}\nb`, layout)).toBe(`a\n${layout.wgsl}\nb`);
  });

  it('throws when the placeholder is missing, repeated or part of another line', () => {
    expect(() => spliceUniformStructs('a\nb', layout)).toThrow(/exactly once/);
    const twice = `${uniformPlaceholder('S')}\n${uniformPlaceholder('S')}`;
    expect(() => spliceUniformStructs(twice, layout)).toThrow(/found 2/);
    expect(() => spliceUniformStructs(`${uniformPlaceholder('S')}Longer`, layout)).toThrow(/exactly once/);
  });
});

interface SpecCase {
  layout: UniformLayout<readonly UniformFieldSpec[]>;
  floats: number;
  /** Slots other code relies on: CPU references, per-draw pokes, the key block. */
  slots: Record<string, number>;
  /** Catalogue names of the shaders that bind this struct. */
  shaders: string[];
}

const SPECS: SpecCase[] = [
  {
    layout: GRAIN_UNIFORMS,
    floats: 24,
    slots: { amount: 0, frameSeed: 7, texelSize: 12, blurAxis: 14, quality: 16, monochromeBias: 17, temporalCoherence: 18, responseShadows: 20, responseHighlights: 22 },
    shaders: ['grain.wgsl'],
  },
  {
    layout: SHARPEN_UNIFORMS,
    floats: 8,
    slots: { amount: 0, midtoneDetail: 3, texelSize: 4, mode: 6 },
    shaders: ['sharpen.wgsl', 'sharpen.wgsl (scene-linear)'],
  },
  {
    layout: NOISE_REDUCTION_UNIFORMS,
    floats: 16,
    slots: { amount: 0, temporalStrength: 3, hasPrev: 7, texelSize: 8, quality: 10, _pad2: 12 },
    shaders: ['denoise.wgsl', 'denoise.wgsl (scene-linear)'],
  },
  {
    layout: CURVES_UNIFORMS,
    floats: 12 + 4 * CURVE_KNOTS_PER_CHANNEL * 4,
    slots: { levels0: 0, levels1: 4, counts: 8, knots: 12 },
    shaders: ['curves.wgsl', 'curves.wgsl (scene-linear)'],
  },
  {
    layout: BLOOM_UNIFORMS,
    floats: 12,
    slots: { srcTexel: 0, threshold: 2, knee: 3, weight: 4, gain: 6, norm: 7, tint: 8, _pad: 11 },
    shaders: ['bloom.wgsl', 'bloom.wgsl (scene-linear)'],
  },
  {
    layout: CHROMATIC_ABERRATION_UNIFORMS,
    floats: 8,
    slots: { radialK: 0, dirX: 1, dirY: 2, spectral: 3, _pad0: 4 },
    shaders: ['chromaticAberration.wgsl'],
  },
  {
    layout: PREVIEW_LAYER_UNIFORMS,
    floats: 36,
    slots: {
      fadeIn: 0,
      opacity: 4,
      destX: 9,
      destH: 12,
      bass: AUDIO_UNIFORM_OFFSET.bass,
      mid: AUDIO_UNIFORM_OFFSET.mid,
      treble: AUDIO_UNIFORM_OFFSET.treble,
      beat: AUDIO_UNIFORM_OFFSET.beat,
      warpA: 17,
      warpTy: 22,
      keyMode: 23,
      keyBlend: 28,
      warpMask: 29,
      quadH: 33,
      keySourceP3: 34,
      _pad1: 35,
    },
    shaders: ['preview.wgsl'],
  },
];

describe('uniform specs', () => {
  const shaders = new Map(listAssembledShaders().map((s) => [s.name, s.code]));

  it.each(SPECS.map((c) => [c.layout.structName, c] as const))('%s: size, slots and shaders', (_name, c) => {
    expect(c.layout.floats).toBe(c.floats);
    expect(c.layout.byteSize).toBe(c.floats * 4);
    expect(c.layout.byteSize % 16).toBe(0);
    for (const [field, slot] of Object.entries(c.slots)) {
      expect(c.layout.offsets[field as keyof typeof c.layout.offsets], field).toBe(slot);
    }
    for (const name of c.shaders) {
      const code = shaders.get(name);
      expect(code, name).toBeDefined();
      expect(code!.split(c.layout.wgsl)).toHaveLength(2);
    }
  });

  it('keeps the key block contiguous in the layer uniforms', () => {
    const base = PREVIEW_LAYER_UNIFORMS.offsets.keyMode;
    KEY_UNIFORM_FIELDS.forEach((field, i) => {
      expect(PREVIEW_LAYER_UNIFORMS.offsets[field.name]).toBe(base + i);
    });
  });

  it('bloom tint is a vec3 that shares its vec4 with the pad', () => {
    const tint = BLOOM_UNIFORMS.placements.find((p) => p.name === 'tint');
    expect(tint).toMatchObject({ type: 'vec3', byteOffset: 32, byteSize: 12 });
  });
});

describe('the shader catalogue', () => {
  const shaders = listAssembledShaders();

  it('covers every shader file and leaves no placeholder unspliced', () => {
    const files = Object.keys(import.meta.glob('./shaders/*.wgsl')).map((p) => p.replace('./shaders/', ''));
    const names = new Set(shaders.map((s) => s.name.split(' ')[0]));
    for (const file of files) expect(names, file).toContain(file);
    for (const s of shaders) expect(s.code, s.name).not.toContain('// @uniforms');
  });

  it('includes every registered transition', () => {
    expect(shaders.filter((s) => s.name.startsWith('transition:')).length).toBeGreaterThan(10);
  });

  it('has unique names', () => {
    expect(new Set(shaders.map((s) => s.name)).size).toBe(shaders.length);
  });
});
