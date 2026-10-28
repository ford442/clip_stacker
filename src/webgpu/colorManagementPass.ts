/**
 * Input, output, and swapchain-present transforms for the managed color path.
 * One pipeline per target format. An f16 matrix variant is used only when the
 * device actually adopted `shader-f16`.
 */

import colorShader from './shaders/colorManagement.wgsl?raw';
import {
  COLOR_XFORM_UNIFORM_FLOATS,
  type ColorXformModeId,
  packColorXformUniforms,
} from '../utils/colorManagement';

const APPLY_MATRIX_F32 = `fn applyMatrix(row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(row0.xyz, c), dot(row1.xyz, c), dot(row2.xyz, c));
}`;

const APPLY_MATRIX_F16 = `fn applyMatrix(row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, c: vec3<f32>) -> vec3<f32> {
  let cf = vec3<f16>(c);
  let r0 = vec3<f16>(row0.xyz);
  let r1 = vec3<f16>(row1.xyz);
  let r2 = vec3<f16>(row2.xyz);
  return vec3<f32>(dot(r0, cf), dot(r1, cf), dot(r2, cf));
}`;

export function colorManagementShaderF16(code: string = colorShader): string {
  return `enable f16;\n${code.replace(APPLY_MATRIX_F32, APPLY_MATRIX_F16)}`;
}

function shaderForDevice(device: GPUDevice): string {
  if (device.features?.has?.('shader-f16' as GPUFeatureName)) {
    return colorManagementShaderF16();
  }
  return colorShader;
}

export class ColorManagementGpuPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(COLOR_XFORM_UNIFORM_FLOATS);

  private constructor(
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
  ) {
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): ColorManagementGpuPass {
    let code = shaderForDevice(device);
    let shaderModule: GPUShaderModule;
    try {
      shaderModule = device.createShaderModule({ code });
    } catch {
      code = colorShader;
      shaderModule = device.createShaderModule({ code });
    }
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const uniformBuffer = device.createBuffer({
      size: COLOR_XFORM_UNIFORM_FLOATS * 4,
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
    let pipeline: GPURenderPipeline;
    try {
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex: { module: shaderModule, entryPoint: 'vs_main' },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format }],
        },
        primitive: { topology: 'triangle-list' },
      });
    } catch {
      const fallbackModule = device.createShaderModule({ code: colorShader });
      pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex: { module: fallbackModule, entryPoint: 'vs_main' },
        fragment: {
          module: fallbackModule,
          entryPoint: 'fs_main',
          targets: [{ format }],
        },
        primitive: { topology: 'triangle-list' },
      });
    }
    return new ColorManagementGpuPass(pipeline, sampler, uniformBuffer);
  }

  applyBetweenTextures(
    device: GPUDevice,
    inputTexture: GPUTexture,
    outputView: GPUTextureView,
    mode: ColorXformModeId,
    commandEncoder: GPUCommandEncoder,
  ): void {
    packColorXformUniforms(mode, this.uniformData);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    const bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    const pass = commandEncoder.beginRenderPass({
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
    this.uniformBuffer.destroy();
  }
}
