/**
 * Device-scoped GPU objects for `PreviewEngine`: the swapchain configuration
 * and the pipelines / samplers / buffers it rebuilds after a device loss.
 */

import previewShader from "./shaders/preview.wgsl?raw";
import overlayShader from "./shaders/overlay.wgsl?raw";
import {
  createTransitionPipelineCache,
  TRANSITION_UNIFORM_FLOATS,
} from "./transitions/transitionPass";
import { FinishingPassChain } from "./finishingPassChain";
import { UNIFORM_FLOATS } from "./previewLayerUniforms";

// Numeric GPUTextureUsage flags (spec values) so this module can load in tests
// without a WebGPU environment.
const GPU_TEX_COPY_SRC = 0x01;
export const GPU_TEX_COPY_DST = 0x02;
export const GPU_TEX_TEXTURE_BINDING = 0x04;
const GPU_TEX_RENDER_ATTACHMENT = 0x10;

// RENDER_ATTACHMENT (we draw into it) + COPY_SRC (VideoFrame/VideoEncoder and
// the finishing pass chain read it back) is all a canvas swapchain texture
// ever needs. COPY_DST / TEXTURE_BINDING are not portable across adapters —
// some reject configure() outright — and nothing here samples or copies into
// the canvas texture; the finishing chain copies FROM it into an offscreen
// ping-pong texture and renders back onto it as a color attachment.
export const CANVAS_TEXTURE_USAGE = GPU_TEX_RENDER_ATTACHMENT | GPU_TEX_COPY_SRC;

/** Shared `GPUCanvasContext.configure()` options (initial configure, resize, and device-recovery reconfigure). */
export function canvasConfiguration(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPUCanvasConfiguration {
  return {
    device,
    format,
    alphaMode: "premultiplied",
    usage: CANVAS_TEXTURE_USAGE,
    colorSpace: "srgb",
    toneMapping: { mode: "standard" },
  };
}

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
  const shaderModule = device.createShaderModule({ code: previewShader });
  const overlayModule = device.createShaderModule({ code: overlayShader });

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  const uniformBuffer = device.createBuffer({
    size: UNIFORM_FLOATS * 4,
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
