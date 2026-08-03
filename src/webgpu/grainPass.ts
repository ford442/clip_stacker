/**
 * Film grain + optical emulation pass — always last in the finishing chain.
 * Procedural grain is seeded by integer frame index for WYSIWYG export/preview.
 */

import grainShader from './shaders/grain.wgsl?raw';
import type { GrainPass } from '../utils/finishing';
import {
  GRAIN_UNIFORM_FLOATS,
  packGrainUniforms,
} from '../utils/grain';

export class GrainGpuPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(GRAIN_UNIFORM_FLOATS);
  private inputTexture: GPUTexture | null = null;
  private inputWidth = 0;
  private inputHeight = 0;

  private constructor(
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
  ) {
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): GrainGpuPass {
    const shaderModule = device.createShaderModule({ code: grainShader });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const uniformBuffer = device.createBuffer({
      size: GRAIN_UNIFORM_FLOATS * 4,
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

    return new GrainGpuPass(pipeline, sampler, uniformBuffer);
  }

  /**
   * Run the grain shader from an input texture to an output render target.
   * Used by FinishingPassChain as the always-last pass.
   */
  applyBetweenTextures(
    device: GPUDevice,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: GrainPass,
    frameSeed: number,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (!settings.enabled) return;

    const encoder = device.createCommandEncoder();
    this.encodePass(
      device,
      encoder,
      inputTexture,
      outputView,
      width,
      height,
      settings,
      frameSeed,
    );
    device.queue.submit([encoder.finish()]);
  }

  private encodePass(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: GrainPass,
    frameSeed: number,
  ): void {
    packGrainUniforms(settings, width, height, frameSeed, this.uniformData);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

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
  }

  destroy(): void {
    this.inputTexture?.destroy();
    this.uniformBuffer.destroy();
    this.inputTexture = null;
  }
}
