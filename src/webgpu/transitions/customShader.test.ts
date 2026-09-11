import { beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_TRANSITION_TYPE,
  DEFAULT_CUSTOM_EXPRESSION,
  __clearCustomTransitionsForTests,
  buildCustomTransitionDef,
  compileCustomTransition,
  customTransitionId,
  getCustomTransitionDef,
  isCustomTransitionId,
  registerCustomTransition,
  validateCustomExpression,
} from './customShader';
import { buildTransitionShader } from './shaderTemplate';
import { createFakeGpu } from './gpuTestStub';

beforeEach(() => {
  __clearCustomTransitionsForTests();
});

describe('validateCustomExpression', () => {
  it('accepts a single expression built from the template helpers', () => {
    expect(validateCustomExpression(DEFAULT_CUSTOM_EXPRESSION)).toEqual({ ok: true });
    expect(
      validateCustomExpression(
        'mix(sampleFrom(uv), sampleTo(uv), smoothstep(0.0, 1.0, u.progress + u.custom0))',
      ).ok,
    ).toBe(true);
  });

  it.each([
    ['', 'Expression is empty.'],
    ['   ', 'Expression is empty.'],
    ['sampleTo(uv); discard', 'Statements are not allowed — write a single expression.'],
    ['sampleTo(uv) // trailing', 'Comments are not allowed inside the expression.'],
    ['@fragment sampleTo(uv)', 'Attributes (@…) are not allowed.'],
    ['fn evil() -> f32 { 1.0 }', 'Function declarations are not allowed.'],
    ['struct S { a: f32 }', 'Struct declarations are not allowed.'],
    ['let x = sampleTo(uv)', 'Declarations are not allowed — write a single expression.'],
    ['enable f16', 'Directives are not allowed.'],
    ['if (true) { sampleTo(uv) }', 'Control flow is not allowed — write a single expression.'],
    ['mix(sampleFrom(uv), sampleTo(uv)', 'Unclosed "(".'],
    ['sampleTo(uv))', 'Unbalanced ")".'],
  ])('rejects %j', (expression, error) => {
    expect(validateCustomExpression(expression)).toEqual({ ok: false, error });
  });

  it('rejects expressions past the length cap', () => {
    const long = `${'mix(sampleFrom(uv), sampleTo(uv), u.progress)'.padEnd(2001, ' ')}`;
    const result = validateCustomExpression(`${long}x`.trim());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too long/);
  });
});

describe('registerCustomTransition', () => {
  it('is content-addressed and idempotent', () => {
    const expr = 'mix(sampleTo(uv), sampleFrom(uv), u.progress)';
    const first = registerCustomTransition(expr);
    const second = registerCustomTransition(`  ${expr}  `);
    expect(first).toBe(second);
    expect(first).toBe(customTransitionId(expr));
    expect(isCustomTransitionId(first)).toBe(true);
    expect(getCustomTransitionDef(first)?.wgslBody).toContain(expr);
  });

  it('gives different expressions different shader ids', () => {
    const a = registerCustomTransition('sampleFrom(uv)');
    const b = registerCustomTransition('sampleTo(uv)');
    expect(a).not.toBe(b);
  });

  it('falls back to the base custom id for invalid WGSL', () => {
    expect(registerCustomTransition('let x = 1.0;')).toBe(CUSTOM_TRANSITION_TYPE);
    expect(getCustomTransitionDef(CUSTOM_TRANSITION_TYPE)).toBeUndefined();
  });

  it('evicts the coldest variants so pipelines stay bounded', () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(registerCustomTransition(`mix(sampleFrom(uv), sampleTo(uv), u.progress * ${i}.0)`));
    }
    expect(getCustomTransitionDef(ids[0])).toBeUndefined();
    expect(getCustomTransitionDef(ids[19])).toBeDefined();
    // Re-registering a dropped expression brings it straight back.
    expect(registerCustomTransition('mix(sampleFrom(uv), sampleTo(uv), u.progress * 0.0)')).toBe(
      ids[0],
    );
  });
});

describe('buildCustomTransitionDef', () => {
  it('substitutes the expression into the shared template', () => {
    const shader = buildTransitionShader(
      buildCustomTransitionDef('sampleMask(uv)'),
    );
    expect(shader).toContain('result = (sampleMask(uv));');
    expect(shader).toContain('fn sampleMaskLuma');
    expect(shader).toContain('@fragment');
  });
});

describe('compileCustomTransition', () => {
  it('reports the static failure without touching the device', () => {
    const gpu = createFakeGpu();
    return compileCustomTransition(gpu.device, 'sampleTo(uv);').then((res) => {
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Statements are not allowed/);
      expect(gpu.shaderCodes).toHaveLength(0);
    });
  });

  it('compiles a valid expression and discards the module', async () => {
    const gpu = createFakeGpu();
    const res = await compileCustomTransition(gpu.device, DEFAULT_CUSTOM_EXPRESSION);
    expect(res).toEqual({ ok: true });
    expect(gpu.shaderCodes).toHaveLength(1);
    expect(gpu.pipelineCount).toBe(0);
  });

  it('surfaces the driver compilation message', async () => {
    const gpu = createFakeGpu();
    gpu.compilationErrors = ['unresolved identifier: sampleNope'];
    const res = await compileCustomTransition(gpu.device, 'sampleNope(uv)');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unresolved identifier: sampleNope');
  });

  it('reports a thrown createShaderModule as an error instead of rejecting', async () => {
    const gpu = createFakeGpu();
    const device = {
      ...gpu.device,
      pushErrorScope: () => {},
      popErrorScope: async () => null,
      createShaderModule: () => {
        throw new Error('device lost');
      },
    } as unknown as GPUDevice;
    await expect(
      compileCustomTransition(device, DEFAULT_CUSTOM_EXPRESSION),
    ).resolves.toEqual({ ok: false, error: 'device lost' });
  });
});
