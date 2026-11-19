/**
 * Chromatic aberration (lens colour fringe) — finishing pass after sharpen,
 * before grain. Pure resampling, so the same pipeline serves the 8-bit chain
 * and the managed float working space (no scene-linear variant needed).
 */

import chromaticAberrationShaderSource from './shaders/chromaticAberration.wgsl?raw';
import type { ChromaticAberrationPass } from '../finishing/finishing';
import {
  CHROMATIC_ABERRATION_UNIFORM_FLOATS,
  isChromaticAberrationNeutral,
  packChromaticAberrationUniforms,
} from '../finishing/chromaticAberration';
import { spliceUniformStructs } from './uniformLayout';
import { CHROMATIC_ABERRATION_UNIFORMS } from './uniformSpecs';

/** `chromaticAberration.wgsl` with its uniform struct spliced in, as compiled. */
export const CHROMATIC_ABERRATION_SHADER = spliceUniformStructs(
  chromaticAberrationShaderSource,
  CHROMATIC_ABERRATION_UNIFORMS,
);

export class ChromaticAberrationGpuPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(CHROMATIC_ABERRATION_UNIFORM_FLOATS);

  private constructor(
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
  ) {
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): ChromaticAberrationGpuPass {
    const shaderModule = device.createShaderModule({ code: CHROMATIC_ABERRATION_SHADER });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      // Taps near the frame edge land outside it; mirroring continues real
      // content, where clamp-to-edge would smear the border pixel into a stripe.
      addressModeU: 'mirror-repeat',
      addressModeV: 'mirror-repeat',
    });
    const uniformBuffer = device.createBuffer({
      size: CHROMATIC_ABERRATION_UNIFORMS.byteSize,
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
    return new ChromaticAberrationGpuPass(pipeline, sampler, uniformBuffer);
  }

  /** Run the pass from an input texture to an output render target. */
  applyBetweenTextures(
    device: GPUDevice,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: ChromaticAberrationPass,
    commandEncoder?: GPUCommandEncoder,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (isChromaticAberrationNeutral(settings)) return;

    packChromaticAberrationUniforms(settings, width, height, this.uniformData);
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
