/**
 * Device-scoped GPU objects for `PreviewEngine`: the swapchain configuration
 * and the pipelines / samplers / buffers it rebuilds after a device loss.
 */

import previewShaderSource from "./shaders/preview.wgsl?raw";
import overlayShader from "./shaders/overlay.wgsl?raw";
import {
  createTransitionPipelineCache,
  TRANSITION_UNIFORM_FLOATS,
} from "./transitions/transitionPass";
import { FinishingPassChain } from "./finishingPassChain";
import { spliceUniformStructs } from "./uniformLayout";
import { PREVIEW_LAYER_UNIFORMS } from "./uniformSpecs";

/** `preview.wgsl` with its `Uniforms` struct spliced in from the spec. */
export const PREVIEW_SHADER = spliceUniformStructs(previewShaderSource, PREVIEW_LAYER_UNIFORMS);

/** `overlay.wgsl` (the text / caption blit), as compiled. */
export const OVERLAY_SHADER: string = overlayShader;

const PREMULTIPLIED_BLEND: GPUBlendState = {
  color: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};

/**
 * Build the device-scoped pipelines/samplers/buffers. Pulled out of
 * `create()` so a device-loss recovery (see `handleDeviceRecovered`) can
 * rebuild the same resources against the freshly-recreated device instead
 * of leaving this engine's GPU objects bound to a destroyed one.
 */
export function buildPreviewDeviceResources(device: GPUDevice, format: GPUTextureFormat) {
  const shaderModule = device.createShaderModule({ code: PREVIEW_SHADER });
  const overlayModule = device.createShaderModule({ code: OVERLAY_SHADER });

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  const uniformBuffer = device.createBuffer({
    size: PREVIEW_LAYER_UNIFORMS.byteSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const transitionUniformBuffer = device.createBuffer({
    size: TRANSITION_UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const transitionPipelineCache = createTransitionPipelineCache(device, format);
  const finishingChain = FinishingPassChain.create(device, format);

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        externalTexture: {},
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: { module: shaderModule, entryPoint: "vs_main" },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format, blend: PREMULTIPLIED_BLEND }],
    },
    primitive: { topology: "triangle-list" },
  });

  const overlayLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
    ],
  });

  const overlayPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [overlayLayout] }),
    vertex: { module: overlayModule, entryPoint: "vs_main" },
    fragment: {
      module: overlayModule,
      entryPoint: "fs_main",
      targets: [{ format, blend: PREMULTIPLIED_BLEND }],
    },
    primitive: { topology: "triangle-list" },
  });

  const overlaySampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  return {
    pipeline,
    sampler,
    uniformBuffer,
    transitionUniformBuffer,
    transitionPipelineCache,
    finishingChain,
    overlayPipeline,
    overlaySampler,
  };
}
