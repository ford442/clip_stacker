/**
 * Curves & levels — finishing pass after primary color, before secondary.
 * Evaluates levels + monotone-cubic curves per pixel from a uniform array of
 * knots (no LUT texture). The managed chain uses the scene-linear variant.
 */

import curvesShader from './shaders/curves.wgsl?raw';
import { shaderForSceneLinear } from '../utils/colorManagement';
import type { CurvesPass } from '../utils/finishing';
import {
  CURVES_UNIFORM_FLOATS,
  isCurvesNeutral,
  packCurvesUniforms,
} from '../utils/curves';

export class CurvesGpuPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(CURVES_UNIFORM_FLOATS);

  private constructor(
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
  ) {
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
  }

  static create(device: GPUDevice, format: GPUTextureFormat, sceneLinear = false): CurvesGpuPass {
    const shaderModule = device.createShaderModule({
      code: shaderForSceneLinear(curvesShader, sceneLinear),
    });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const uniformBuffer = device.createBuffer({
      size: CURVES_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });
    return new CurvesGpuPass(pipeline, sampler, uniformBuffer);
  }

  /** Run the pass from an input texture to an output render target. */
  applyBetweenTextures(
    device: GPUDevice,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: CurvesPass,
    commandEncoder?: GPUCommandEncoder,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (isCurvesNeutral(settings)) return;

    packCurvesUniforms(settings, this.uniformData);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const encoder = commandEncoder ?? device.createCommandEncoder();
    const bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: outputView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    if (!commandEncoder) device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.uniformBuffer.destroy();
  }
}
