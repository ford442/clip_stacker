import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  TRANSITION_IDS,
  TRANSITION_REGISTRY,
  defaultTransitionParams,
  getTransitionDef,
  getXfadeName,
  isRegisteredTransitionType,
  listTransitionOptions,
  resolveCustomUniforms,
  resolveTransitionShaderId,
} from './registry';
import { buildTransitionShader } from './shaderTemplate';
import {
  CUSTOM_TRANSITION_TYPE,
  DEFAULT_CUSTOM_EXPRESSION,
  __clearCustomTransitionsForTests,
  customTransitionId,
} from './customShader';
import {
  createTransitionPipelineCache,
  renderTransitionPass,
  TRANSITION_UNIFORM_FLOATS,
} from './transitionPass';
import { createFakeGpu, fakeRenderParams, stubGpuGlobals } from './gpuTestStub';
import { getTransitionXfadeName } from '../../utils/transitions';

/** Transitions added for the extended library (issue: richer transition set). */
const NEW_TRANSITION_IDS = [
  'filmBurn',
  'lumaWipe',
  'radialIris',
  'chromaShift',
  'motionBlurPull',
  CUSTOM_TRANSITION_TYPE,
];

beforeAll(() => {
  stubGpuGlobals((name, value) => vi.stubGlobal(name, value));
});

beforeEach(() => {
  __clearCustomTransitionsForTests();
});

describe('webgpu/transitions/registry', () => {
  it('contains at least 10 ported transition shaders', () => {
    expect(TRANSITION_IDS.length).toBeGreaterThanOrEqual(10);
    for (const id of TRANSITION_IDS) {
      expect(TRANSITION_REGISTRY[id]).toBeDefined();
      expect(TRANSITION_REGISTRY[id].wgslBody.length).toBeGreaterThan(0);
    }
  });

  it('builds valid WGSL for every registry entry', () => {
    for (const id of TRANSITION_IDS) {
      const def = getTransitionDef(id)!;
      const shader = buildTransitionShader(def);
      expect(shader).toContain('fn transitionEffect');
      expect(shader).toContain('texture_external');
      expect(shader).toContain(def.wgslBody.trim());
    }
  });

  it('lists all registry entries for the editor', () => {
    const options = listTransitionOptions();
    expect(options.length).toBe(TRANSITION_IDS.length);
    expect(options.map((o) => o.value)).toEqual(TRANSITION_IDS);
  });

  it('maps legacy dissolve and motion ids to FFmpeg xfade names', () => {
    expect(getXfadeName('dissolve')).toBe('fade');
    expect(getXfadeName('motion')).toBe('smoothleft');
    expect(getTransitionXfadeName('glitch')).toBe('hlslice');
  });

  it('resolves directional custom uniforms into slots', () => {
    const def = getTransitionDef('directional');
    const slots = resolveCustomUniforms(def, { dirX: -0.5, dirY: 0.25 });
    expect(slots[0]).toBe(-0.5);
    expect(slots[1]).toBe(0.25);
  });

  it('treats none as unregistered', () => {
    expect(isRegisteredTransitionType('none')).toBe(false);
    expect(isRegisteredTransitionType('dissolve')).toBe(true);
  });

  it('registers the extended transition set with editable params', () => {
    for (const id of NEW_TRANSITION_IDS) {
      const def = getTransitionDef(id);
      expect(def, `missing transition: ${id}`).toBeDefined();
      expect(TRANSITION_IDS).toContain(id);
      expect(isRegisteredTransitionType(id)).toBe(true);
      // Every new transition has an FFmpeg fallback for the export path.
      expect(getXfadeName(id).length).toBeGreaterThan(0);
      expect(getTransitionXfadeName(id)).toBe(def!.xfadeName);
    }
  });

  it('exposes the new transitions in the picker dropdown', () => {
    const values = listTransitionOptions().map((o) => o.value);
    for (const id of NEW_TRANSITION_IDS) {
      expect(values).toContain(id);
    }
  });

  it('maps motion blur taps onto the TAP_COUNT uniform slot', () => {
    const def = getTransitionDef('motionBlurPull')!;
    expect(def.wgslBody).toContain('u.custom1');
    const slots = resolveCustomUniforms(def, { blur: 0.2, taps: 8, pull: 0.5 });
    expect(slots).toEqual([0.2, 8, 0.5, 0]);
    // Defaults land in the same slots when the clip carries no overrides.
    expect(resolveCustomUniforms(def, undefined)).toEqual([0.12, 6, 0.25, 0]);
    expect(defaultTransitionParams(def)).toEqual({ blur: 0.12, taps: 6, pull: 0.25 });
  });

  it('drives the luma wipe from the mask texture, not clip content', () => {
    const def = getTransitionDef('lumaWipe')!;
    expect(def.wgslBody).toContain('sampleMaskLuma(uv)');
    const shader = buildTransitionShader(def);
    expect(shader).toContain('@group(0) @binding(4) var maskTexture: texture_2d<f32>;');
    // Mask luma is clamped, so an HDR source can't push the threshold out of range.
    expect(shader).toContain('clamp(dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.0, 1.0)');
  });
});

describe('webgpu/transitions smoke render', () => {
  function smokeRender(transitionId: string, progress: number, custom?: Record<string, number>) {
    const gpu = createFakeGpu();
    const cache = createTransitionPipelineCache(gpu.device, 'bgra8unorm');
    const uniformData = new Float32Array(TRANSITION_UNIFORM_FLOATS);
    renderTransitionPass(
      gpu.device,
      gpu.context,
      cache,
      gpu.sampler,
      gpu.uniformBuffer,
      uniformData,
      {} as VideoFrame,
      {} as VideoFrame,
      transitionId,
      fakeRenderParams(progress, custom),
      1920,
      1080,
    );
    return { gpu, cache };
  }

  for (const id of NEW_TRANSITION_IDS) {
    it(`renders ${id} end-to-end`, () => {
      const def = getTransitionDef(id)!;
      const { gpu } = smokeRender(id, 0.5);

      expect(gpu.drawCalls).toEqual([6]);
      expect(gpu.pipelineCount).toBe(1);
      // The compiled module is the template wrapped around this transition's body.
      const shader = gpu.shaderCodes.at(-1)!;
      expect(shader).toContain(def.wgslBody.trim());
      expect(shader).toContain('fn transitionEffect');
      // from/to external textures, uniforms, and the wipe mask are all bound.
      expect(gpu.bindGroups[0].map((e) => e.binding)).toEqual([0, 1, 2, 3, 4]);
      expect(gpu.writtenUniforms[0][0]).toBe(0.5);
    });
  }

  it('reuses one pipeline per transition id across frames', () => {
    const gpu = createFakeGpu();
    const cache = createTransitionPipelineCache(gpu.device, 'bgra8unorm');
    cache.getOrCreatePipeline('filmBurn');
    cache.getOrCreatePipeline('filmBurn');
    cache.getOrCreatePipeline('radialIris');
    expect(gpu.pipelineCount).toBe(2);
  });

  it('writes custom params into the uniform slots the shader reads', () => {
    const { gpu } = smokeRender('radialIris', 0.25, {
      centerX: 0.2,
      centerY: 0.8,
      feather: 0.1,
    });
    const uniforms = gpu.writtenUniforms[0];
    expect(uniforms[0]).toBeCloseTo(0.25);
    expect(uniforms[15]).toBeCloseTo(0.2);
    expect(uniforms[16]).toBeCloseTo(0.8);
    expect(uniforms[17]).toBeCloseTo(0.1);
  });

  it('binds a built-in mask until a project uploads its own', () => {
    const gpu = createFakeGpu();
    const cache = createTransitionPipelineCache(gpu.device, 'bgra8unorm');
    // The default diagonal ramp is created up front so lumaWipe works untouched.
    expect(gpu.textureDescriptors[0].format).toBe('rgba8unorm');
    expect(cache.getMaskView()).toBeDefined();

    cache.setMaskImage({ width: 8, height: 8 } as ImageBitmap);
    expect(gpu.externalImageCopies).toBe(1);
    cache.setMaskImage(null);
    cache.destroy();
  });

  it('packs both clips\' stabilization matrices into the transition uniforms', () => {
    const gpu = createFakeGpu();
    const cache = createTransitionPipelineCache(gpu.device, 'bgra8unorm');
    const uniformData = new Float32Array(TRANSITION_UNIFORM_FLOATS);
    renderTransitionPass(
      gpu.device,
      gpu.context,
      cache,
      gpu.sampler,
      gpu.uniformBuffer,
      uniformData,
      {} as VideoFrame,
      {} as VideoFrame,
      'dissolve',
      {
        ...fakeRenderParams(0.5),
        fromStabMatrix: [1, 0, 0.1, 0, 1, 0.2],
        toStabMatrix: [0.9, 0.01, -0.3, -0.01, 0.9, -0.4],
      },
      1920,
      1080,
    );
    const u = gpu.writtenUniforms[0]!;
    // Float32Array storage, so compare at f32 precision.
    [1, 0, 0.1, 0, 1, 0.2].forEach((v, i) => expect(u[20 + i]).toBeCloseTo(v, 6));
    [0.9, 0.01, -0.3, -0.01, 0.9, -0.4].forEach((v, i) =>
      expect(u[26 + i]).toBeCloseTo(v, 6),
    );
    // The shader reads these through sampleFrom/sampleTo, not the body.
    expect(gpu.shaderCodes.at(-1)).toContain('fn stabilize(');
  });

  it('defaults both stabilization slots to identity', () => {
    const { gpu } = smokeRender('dissolve', 0.5);
    const u = gpu.writtenUniforms[0]!;
    expect(Array.from(u.subarray(20, 26))).toEqual([1, 0, 0, 0, 1, 0]);
    expect(Array.from(u.subarray(26, 32))).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('renders a user WGSL expression under its own shader id', () => {
    const expression = 'mix(sampleTo(uv), sampleFrom(uv), u.progress * u.custom0)';
    const id = resolveTransitionShaderId({
      type: CUSTOM_TRANSITION_TYPE,
      customShader: expression,
    });
    expect(id).toBe(customTransitionId(expression));

    const { gpu } = smokeRender(id, 0.75);
    expect(gpu.drawCalls).toEqual([6]);
    expect(gpu.shaderCodes.at(-1)).toContain(`result = (${expression});`);
    // FFmpeg export still has a fallback name for the custom shader.
    expect(getXfadeName(id)).toBe('fade');
  });

  it('falls back to the default dissolve expression for invalid WGSL', () => {
    const id = resolveTransitionShaderId({
      type: CUSTOM_TRANSITION_TYPE,
      customShader: 'let x = 1.0; return x;',
    });
    expect(id).toBe(CUSTOM_TRANSITION_TYPE);
    const { gpu } = smokeRender(id, 0.5);
    expect(gpu.drawCalls).toEqual([6]);
    expect(gpu.shaderCodes.at(-1)).toContain(DEFAULT_CUSTOM_EXPRESSION);
  });

  it('leaves non-custom transitions untouched when resolving ids', () => {
    expect(resolveTransitionShaderId({ type: 'filmBurn' })).toBe('filmBurn');
    expect(resolveTransitionShaderId({ type: CUSTOM_TRANSITION_TYPE })).toBe(
      CUSTOM_TRANSITION_TYPE,
    );
  });

  it('throws for an unknown transition id', () => {
    const gpu = createFakeGpu();
    const cache = createTransitionPipelineCache(gpu.device, 'bgra8unorm');
    expect(() => cache.getOrCreatePipeline('nope')).toThrow(/Unknown transition shader/);
  });
});
