/**
 * Every WGSL module the app compiles, assembled exactly as its pass builds it
 * (uniform structs spliced from `uniformSpecs.ts`, scene-linear variants,
 * the shader-f16 colour variant, each registered transition through the
 * shared template). The `?test_harness` API exposes it so
 * `e2e/shaders.spec.ts` can compile every one on a real WebGPU device, and
 * `uniformLayout.test.ts` checks that each carries its emitted struct.
 */

import { bloomShaderCode } from './bloomPass';
import { CHROMATIC_ABERRATION_SHADER } from './chromaticAberrationPass';
import { COLOR_MANAGEMENT_SHADER, colorManagementShaderF16 } from './colorManagementPass';
import { curvesShaderCode } from './curvesPass';
import { GRAIN_SHADER } from './grainPass';
import { GRAPHICS_OVERLAY_SHADER } from './graphicsOverlayPass';
import { lutShaderCode } from './lutPass';
import { denoiseShaderCode } from './noiseReductionPass';
import { OVERLAY_SHADER, PREVIEW_SHADER } from './previewDeviceResources';
import { PRIMARY_COLOR_SHADER } from './primaryColorPass';
import { secondaryColorShaderCode } from './secondaryColorPass';
import { sharpenShaderCode } from './sharpenPass';
import { TEXT_FILL_SHADER } from './text/textFill';
import { TRANSITION_REGISTRY } from './transitions/registry';
import { buildTransitionShader } from './transitions/shaderTemplate';
import { YUV_PACK_SHADER } from './yuvPackPass';

export interface AssembledShader {
  /** `<file>.wgsl` (plus a variant suffix), or `transition:<id>`. */
  name: string;
  code: string;
  /** A device feature the module needs; skip it on a device without one. */
  requires?: GPUFeatureName;
}

/** Each scene-linear capable pass, in both of its variants. */
const SCENE_LINEAR_PASSES: readonly [string, (sceneLinear: boolean) => string][] = [
  ['denoise.wgsl', denoiseShaderCode],
  ['curves.wgsl', curvesShaderCode],
  ['secondaryColor.wgsl', secondaryColorShaderCode],
  ['lut.wgsl', lutShaderCode],
  ['sharpen.wgsl', sharpenShaderCode],
  ['bloom.wgsl', bloomShaderCode],
];

/** Every shader module the app compiles (see the module comment). */
export function listAssembledShaders(): AssembledShader[] {
  const shaders: AssembledShader[] = [
    { name: 'preview.wgsl', code: PREVIEW_SHADER },
    { name: 'overlay.wgsl', code: OVERLAY_SHADER },
    { name: 'textFill.wgsl', code: TEXT_FILL_SHADER },
    { name: 'primaryColor.wgsl', code: PRIMARY_COLOR_SHADER },
    { name: 'chromaticAberration.wgsl', code: CHROMATIC_ABERRATION_SHADER },
    { name: 'grain.wgsl', code: GRAIN_SHADER },
    { name: 'graphicsOverlay.wgsl', code: GRAPHICS_OVERLAY_SHADER },
    { name: 'yuvPack.wgsl', code: YUV_PACK_SHADER },
    { name: 'colorManagement.wgsl', code: COLOR_MANAGEMENT_SHADER },
    { name: 'colorManagement.wgsl (shader-f16)', code: colorManagementShaderF16(), requires: 'shader-f16' },
  ];
  for (const [name, code] of SCENE_LINEAR_PASSES) {
    shaders.push({ name, code: code(false) }, { name: `${name} (scene-linear)`, code: code(true) });
  }
  for (const def of Object.values(TRANSITION_REGISTRY)) {
    shaders.push({ name: `transition:${def.id}`, code: buildTransitionShader(def) });
  }
  return shaders;
}
