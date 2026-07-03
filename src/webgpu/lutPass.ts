/**
 * Final-stage 3D LUT color-grade pass — samples the composited frame and
 * writes the graded result back to the canvas swapchain texture.
 */

import lutShader from './shaders/lut.wgsl?raw';
import type { LutData } from '../utils/lut';
import { uploadLutTexture } from '../utils/lut';

const LUT_UNIFORM_FLOATS = 4;

export class LutPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(LUT_UNIFORM_FLOATS);
  private inputTexture: GPUTexture | null = null;
  private lutTexture: GPUTexture | null = null;
  private lutSize = 0;
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

  static create(device: GPUDevice, format: GPUTextureFormat): LutPass {
    const shaderModule = device.createShaderModule({ code: lutShader });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const uniformBuffer = device.createBuffer({
      size: LUT_UNIFORM_FLOATS * 4,
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
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 4,
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

    return new LutPass(pipeline, sampler, uniformBuffer);
  }

  setLut(device: GPUDevice, lut: LutData): void {
    this.lutTexture = uploadLutTexture(device, lut, this.lutTexture);
    this.lutSize = lut.size;
  }

  /**
   * Copy the current canvas contents through the LUT shader back onto the canvas.
   */
  apply(
    device: GPUDevice,
    context: GPUCanvasContext,
    width: number,
    height: number,
    intensity: number,
  ): void {
    if (!this.lutTexture || this.lutSize <= 0 || intensity <= 0) return;
    if (width <= 0 || height <= 0) return;

    this.ensureInputTexture(device, width, height);

    const canvasTexture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: canvasTexture },
      { texture: this.inputTexture! },
      [width, height, 1],
    );

    this.uniformData[0] = intensity;
    this.uniformData[1] = this.lutSize;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.inputTexture!.createView() },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.lutTexture.createView() },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: canvasTexture.createView(),
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
    this.inputTexture?.destroy();
    this.lutTexture?.destroy();
    this.uniformBuffer.destroy();
    this.inputTexture = null;
    this.lutTexture = null;
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
