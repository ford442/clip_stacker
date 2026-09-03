/**
 * Film grain + optical emulation pass — always last in the finishing chain.
 * Procedural grain is seeded by integer frame index for WYSIWYG export/preview.
 * Bloom / halation use a separable Gaussian (H then V) matching the old 17×17 kernel.
 */

import grainShader from './shaders/grain.wgsl?raw';
import type { GrainPass } from '../utils/finishing';
import {
  GRAIN_UNIFORM_FLOATS,
  grainWantsOpticalBlur,
  packGrainUniforms,
} from '../utils/grain';

export class GrainGpuPass {
  private readonly grainPipeline: GPURenderPipeline;
  private readonly blurPipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly blurUniformH: GPUBuffer;
  private readonly blurUniformV: GPUBuffer;
  private readonly uniformData = new Float32Array(GRAIN_UNIFORM_FLOATS);
  private readonly format: GPUTextureFormat;
  private blurPing: GPUTexture | null = null;
  private blurPong: GPUTexture | null = null;
  private blurWidth = 0;
  private blurHeight = 0;

  private constructor(
    grainPipeline: GPURenderPipeline,
    blurPipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
    blurUniformH: GPUBuffer,
    blurUniformV: GPUBuffer,
    format: GPUTextureFormat,
  ) {
    this.grainPipeline = grainPipeline;
    this.blurPipeline = blurPipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
    this.blurUniformH = blurUniformH;
    this.blurUniformV = blurUniformV;
    this.format = format;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): GrainGpuPass {
    const shaderModule = device.createShaderModule({ code: grainShader });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const uniformBuffer = device.createBuffer({
      size: GRAIN_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const blurUniformH = device.createBuffer({
      size: GRAIN_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const blurUniformV = device.createBuffer({
      size: GRAIN_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const blurLayout = device.createBindGroupLayout({
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

    const grainLayout = device.createBindGroupLayout({
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
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
      ],
    });

    const blurPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [blurLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_blur',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const grainPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [grainLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    return new GrainGpuPass(
      grainPipeline,
      blurPipeline,
      sampler,
      uniformBuffer,
      blurUniformH,
      blurUniformV,
      format,
    );
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
    commandEncoder?: GPUCommandEncoder,
  ): void {
    if (width <= 0 || height <= 0) return;
    if (!settings.enabled) return;

    const ownsEncoder = !commandEncoder;
    const encoder = commandEncoder ?? device.createCommandEncoder();

    packGrainUniforms(settings, width, height, frameSeed, this.uniformData);

    let blurred = inputTexture;
    if (grainWantsOpticalBlur(settings)) {
      this.ensureBlurTextures(device, width, height);
      this.encodeBlurPass(device, encoder, inputTexture, this.blurPing!.createView(), 0);
      this.encodeBlurPass(device, encoder, this.blurPing!, this.blurPong!.createView(), 1);
      blurred = this.blurPong!;
    }

    this.encodeGrainPass(
      device,
      encoder,
      inputTexture,
      blurred,
      outputView,
      width,
      height,
      settings,
      frameSeed,
    );

    if (ownsEncoder) device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.blurPing?.destroy();
    this.blurPong?.destroy();
    this.uniformBuffer.destroy();
    this.blurUniformH.destroy();
    this.blurUniformV.destroy();
    this.blurPing = null;
    this.blurPong = null;
  }

  private encodeBlurPass(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    axis: 0 | 1,
  ): void {
    const buffer = axis === 0 ? this.blurUniformH : this.blurUniformV;
    this.uniformData[14] = axis;
    device.queue.writeBuffer(buffer, 0, this.uniformData);

    const bindGroup = device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: { buffer } },
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
    pass.setPipeline(this.blurPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  private encodeGrainPass(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    blurredTexture: GPUTexture,
    outputView: GPUTextureView,
    width: number,
    height: number,
    settings: GrainPass,
    frameSeed: number,
  ): void {
    packGrainUniforms(settings, width, height, frameSeed, this.uniformData);
    this.uniformData[14] = 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const bindGroup = device.createBindGroup({
      layout: this.grainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
        { binding: 3, resource: blurredTexture.createView() },
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
    pass.setPipeline(this.grainPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  private ensureBlurTextures(device: GPUDevice, width: number, height: number): void {
    if (this.blurPing && this.blurWidth === width && this.blurHeight === height) {
      return;
    }
    this.blurPing?.destroy();
    this.blurPong?.destroy();
    const descriptor: GPUTextureDescriptor = {
      size: [width, height, 1],
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    };
    this.blurPing = device.createTexture(descriptor);
    this.blurPong = device.createTexture(descriptor);
    this.blurWidth = width;
    this.blurHeight = height;
  }
}
