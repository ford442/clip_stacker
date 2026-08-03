/**
 * Spatial + optional temporal noise reduction pass.
 * Runs first in the finishing chain (before primary color / LUT).
 */

import denoiseShader from './shaders/denoise.wgsl?raw';
import type { NoiseReductionPass } from '../utils/finishing';
import {
  NOISE_REDUCTION_UNIFORM_FLOATS,
  packNoiseReductionUniforms,
} from '../utils/noiseReduction';

export class NoiseReductionGpuPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(NOISE_REDUCTION_UNIFORM_FLOATS);
  /** 1×1 black texture bound when no previous frame is available. */
  private readonly dummyPrevTexture: GPUTexture;
  private inputWidth = 0;
  private inputHeight = 0;

  private constructor(
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
    dummyPrevTexture: GPUTexture,
  ) {
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
    this.dummyPrevTexture = dummyPrevTexture;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): NoiseReductionGpuPass {
    const shaderModule = device.createShaderModule({ code: denoiseShader });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const uniformBuffer = device.createBuffer({
      size: NOISE_REDUCTION_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const dummyPrevTexture = device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: dummyPrevTexture },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1],
    );

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
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
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

    return new NoiseReductionGpuPass(pipeline, sampler, uniformBuffer, dummyPrevTexture);
  }

  /**
   * Run denoise from an input texture to an output render target.
   * When `prevTexture` is provided and temporal is enabled, blends with it.
   */
  applyBetweenTextures(
    device: GPUDevice,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: NoiseReductionPass,
    prevTexture: GPUTexture | null,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (!settings.enabled || (settings.amount ?? 1) <= 0) return;

    this.inputWidth = width;
    this.inputHeight = height;

    const hasPrev = Boolean(prevTexture) && settings.temporal === true;
    packNoiseReductionUniforms(
      settings,
      width,
      height,
      hasPrev,
      this.uniformData,
    );
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const prevResource = (prevTexture ?? this.dummyPrevTexture).createView();
    const bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: prevResource },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
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
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.dummyPrevTexture.destroy();
  }
}
