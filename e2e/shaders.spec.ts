/**
 * Every WGSL module the app compiles, compiled on a real WebGPU device
 * (SwiftShader in CI): each file in `src/webgpu/shaders/` as its pass
 * assembles it (uniform structs spliced from `uniformSpecs.ts`, scene-linear
 * and shader-f16 variants) and every registered transition through the
 * shared template. Any compilation error or warning fails the run, so a
 * shader that only one pass or one colour mode builds can no longer break
 * unnoticed. The list comes from `window.clipStacker.test.listShaders()`
 * (`src/webgpu/shaderCatalog.ts`).
 */
import { expect, test } from '@playwright/test';
import { openHarness } from './harness';

interface CompileReport {
  compiled: string[];
  skipped: string[];
  problems: string[];
}

test('every assembled shader compiles without errors or warnings', async ({ page }) => {
  await openHarness(page);
  const report = await page.evaluate(async (): Promise<CompileReport> => {
    const shaders = window.clipStacker!.test!.listShaders();
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const wanted: GPUFeatureName[] = adapter.features.has('shader-f16') ? ['shader-f16'] : [];
    const device = await adapter.requestDevice({ requiredFeatures: wanted });
    const out: CompileReport = { compiled: [], skipped: [], problems: [] };
    for (const shader of shaders) {
      if (shader.requires && !device.features.has(shader.requires)) {
        out.skipped.push(shader.name);
        continue;
      }
      device.pushErrorScope('validation');
      const module = device.createShaderModule({ label: shader.name, code: shader.code });
      const info = await module.getCompilationInfo();
      const scoped = await device.popErrorScope();
      for (const m of info.messages) {
        if (m.type === 'error' || m.type === 'warning') {
          out.problems.push(`${shader.name}:${m.lineNum}:${m.linePos} ${m.type}: ${m.message}`);
        }
      }
      if (scoped) out.problems.push(`${shader.name}: ${scoped.message}`);
      out.compiled.push(shader.name);
    }
    device.destroy();
    return out;
  });

  expect(report.problems, 'shader compilation messages').toEqual([]);
  // Fifteen shader files, six of them in two variants, plus the transitions.
  expect(report.compiled.length + report.skipped.length).toBeGreaterThan(30);
  for (const file of ['preview.wgsl', 'grain.wgsl', 'curves.wgsl (scene-linear)', 'transition:custom']) {
    expect(report.compiled).toContain(file);
  }
  test.info().annotations.push({
    type: 'shaders',
    description: `${report.compiled.length} compiled, skipped (missing feature): ${report.skipped.join(', ') || 'none'}`,
  });
});
