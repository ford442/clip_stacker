/**
 * Secondary / selective color pass — hue qualifiers + soft elliptical windows.
 * Full-frame pass after primary color, before creative LUT.
 */

import secondaryColorShader from './shaders/secondaryColor.wgsl?raw';
import type { SecondaryColorPass } from '../utils/finishing';
import {
  SECONDARY_COLOR_UNIFORM_FLOATS,
  packSecondaryColorUniforms,
} from '../utils/secondaryColor';

export class SecondaryColorGpuPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(SECONDARY_COLOR_UNIFORM_FLOATS);
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

  static create(device: GPUDevice, format: GPUTextureFormat): SecondaryColorGpuPass {
    const shaderModule = device.createShaderModule({ code: secondaryColorShader });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const uniformBuffer = device.createBuffer({
      size: SECONDARY_COLOR_UNIFORM_FLOATS * 4,
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

    return new SecondaryColorGpuPass(pipeline, sampler, uniformBuffer);
  }

  /**
   * Copy the current canvas contents through the secondary color shader back onto the canvas.
   */
  apply(
    device: GPUDevice,
    context: GPUCanvasContext,
    width: number,
    height: number,
    settings: SecondaryColorPass,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (!settings.enabled || (settings.amount ?? 1) <= 0) return;

    this.ensureInputTexture(device, width, height);

    const canvasTexture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: canvasTexture },
      { texture: this.inputTexture! },
      [width, height, 1],
    );

    this.encodePass(
      device,
      encoder,
      this.inputTexture!,
      canvasTexture.createView(),
      settings,
    );
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Run the secondary color shader from an input texture to an output render target.
   * Used by FinishingPassChain for ping-pong intermediate passes.
   */
  applyBetweenTextures(
    device: GPUDevice,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: SecondaryColorPass,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (!settings.enabled || (settings.amount ?? 1) <= 0) return;

    const encoder = device.createCommandEncoder();
    this.encodePass(device, encoder, inputTexture, outputView, settings);
    device.queue.submit([encoder.finish()]);
  }

  private encodePass(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    settings: SecondaryColorPass,
  ): void {
    packSecondaryColorUniforms(settings, this.uniformData);
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

  private ensureInputTexture(device: GPUDevice, width: number, height: number): void {
    if (
      this.inputTexture &&
      this.inputWidth === width &&
      this.inputHeight === height
    ) {
      return;
    }
    this.inputTexture?.destroy();
    this.inputTexture = device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.inputWidth = width;
    this.inputHeight = height;
  }
}
