import previewShader from "./shaders/preview.wgsl?raw";
import overlayShader from "./shaders/overlay.wgsl?raw";
import { acquireGpuContext } from "./gpuDevice";
import {
  createTransitionPipelineCache,
  renderTransitionPass,
  TRANSITION_UNIFORM_FLOATS,
  type TransitionPipelineCache,
} from "./transitions/transitionPass";
import type { TransitionRenderParams } from "./transitions/types";
import { FinishingPassChain } from "./finishingPassChain";
import { adoptGpuDevice } from "../gpu-chores/device";
import type { ColorGradeSettings } from "../utils/lut";
import { isColorGradeActive } from "../utils/lut";
import type { FinishingSettings } from "../utils/finishing";
import { isFinishingActive } from "../utils/finishing";
import {
  AUDIO_UNIFORM_OFFSET,
  ZERO_AUDIO_REACTIVE,
  type AudioReactiveState,
} from "../wasm/audioReactiveUniforms";
import {
  IDENTITY_STAB_MATRIX,
  type StabMatrix,
} from "../wasm/videoStabilize";

/**
 * WebGPU-based clip preview engine.
 *
 * Renders video frames to a canvas with real-time fade-in/out effects applied
 * via WGSL shaders. VideoFrame → GPUExternalTexture is zero-copy in Chromium.
 *
 * Usage:
 *   const engine = await PreviewEngine.create(canvas);
 *   // In rAF / requestVideoFrameCallback:
 *   await engine.renderFrame(videoFrame, elapsed, duration, fadeIn, fadeOut, opacity);
 *   videoFrame.close(); // always close after use
 *   // Cleanup:
 *   engine.destroy();
 */

/** Must match WGSL Uniforms (20 floats = 80 bytes, 16-byte aligned). */
const UNIFORM_FLOATS = 24;

/** First slot of the stabilization affine in `Uniforms` (must match preview.wgsl). */
const STAB_UNIFORM_OFFSET = 17;

// Numeric GPUTextureUsage flags (spec values) so this module can load in tests
// without a WebGPU environment.
const GPU_TEX_COPY_SRC = 0x01;
const GPU_TEX_COPY_DST = 0x02;
const GPU_TEX_TEXTURE_BINDING = 0x04;
const GPU_TEX_RENDER_ATTACHMENT = 0x10;

const CANVAS_TEXTURE_USAGE =
  GPU_TEX_RENDER_ATTACHMENT |
  GPU_TEX_COPY_SRC |
  GPU_TEX_COPY_DST |
  GPU_TEX_TEXTURE_BINDING;

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

export interface NormalizedDestRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayerRenderParams {
  elapsed: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  opacity: number;
  uvScale: [number, number];
  uvOffset: [number, number];
  /**
   * Camera-shake correction as an inverse-warp 2x3 affine in normalized UV,
   * `[a, b, tx, c, d, ty]`. Omit (or pass identity) for unstabilized clips.
   */
  stabMatrix?: StabMatrix;
  /** Destination rectangle on the canvas in normalized 0–1 coordinates. */
  destRect?: NormalizedDestRect;
  /** When true, clears the canvas before drawing this layer. */
  clear?: boolean;
}

export interface LayerDraw {
  videoFrame: VideoFrame;
  params: LayerRenderParams;
}

export class PreviewEngine {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private uniformData = new Float32Array(UNIFORM_FLOATS);
  private extraLayerUniformBuffers: GPUBuffer[] = [];
  private transitionUniformBuffer: GPUBuffer;
  private transitionUniformData = new Float32Array(TRANSITION_UNIFORM_FLOATS);
  private transitionPipelineCache: TransitionPipelineCache;
  private finishingChain: FinishingPassChain;
  private overlayPipeline: GPURenderPipeline;
  private overlaySampler: GPUSampler;
  private overlayTexture: GPUTexture | null = null;
  private overlayWidth = 0;
  private overlayHeight = 0;
  private destroyed = false;
  private audioReactive: AudioReactiveState = { ...ZERO_AUDIO_REACTIVE };
  private format: GPUTextureFormat;
  private canvas: HTMLCanvasElement | OffscreenCanvas;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
    transitionUniformBuffer: GPUBuffer,
    transitionPipelineCache: TransitionPipelineCache,
    finishingChain: FinishingPassChain,
    overlayPipeline: GPURenderPipeline,
    overlaySampler: GPUSampler,
    format: GPUTextureFormat,
  ) {
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
    this.transitionUniformBuffer = transitionUniformBuffer;
    this.transitionPipelineCache = transitionPipelineCache;
    this.finishingChain = finishingChain;
    this.overlayPipeline = overlayPipeline;
    this.overlaySampler = overlaySampler;
    this.format = format;
    this.canvas = { width: 0, height: 0 } as unknown as OffscreenCanvas;
  }

  /**
   * Reconfigure the WebGPU canvas context after the canvas element is resized.
   * Without this, getCurrentTexture() may continue to serve the old size.
   */
  resize(): void {
    if (this.destroyed) return;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied",
      usage: CANVAS_TEXTURE_USAGE,
    });
  }

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<PreviewEngine> {
    const { device, format } = await acquireGpuContext();

    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw new Error("Could not get WebGPU context from canvas");

    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
      usage: CANVAS_TEXTURE_USAGE,
    });

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

    const engine = new PreviewEngine(
      device,
      context,
      pipeline,
      sampler,
      uniformBuffer,
      transitionUniformBuffer,
      transitionPipelineCache,
      finishingChain,
      overlayPipeline,
      overlaySampler,
      format,
    );
    engine.canvas = canvas;
    adoptGpuDevice(device);
    return engine;
  }

  /**
   * Render one video frame with fade applied.
   * @param videoFrame  - Current VideoFrame (caller must close() it after this call)
   * @param elapsed     - Playback position within the clip (seconds)
   * @param duration    - Total clip duration (seconds)
   * @param fadeIn      - Fade-in duration (seconds)
   * @param fadeOut     - Fade-out duration (seconds)
   * @param opacity     - Overall clip opacity (0–1)
   */
  renderFrame(
    videoFrame: VideoFrame,
    elapsed: number,
    duration: number,
    fadeIn: number,
    fadeOut: number,
    opacity = 1,
    uvScale: [number, number] = [1, 1],
    uvOffset: [number, number] = [0, 0],
  ): void {
    this.renderLayer(videoFrame, {
      elapsed,
      duration,
      fadeIn,
      fadeOut,
      opacity,
      uvScale,
      uvOffset,
      destRect: { x: 0, y: 0, w: 1, h: 1 },
      clear: true,
    });
  }

  /**
   * Update audio-reactive uniforms (bass / mid / treble / beat) from WASM analysis.
   * Pass zeros or call with no args to disable the shader modulation.
   */
  setAudioReactive(state: AudioReactiveState = ZERO_AUDIO_REACTIVE): void {
    this.audioReactive = {
      bass: state.bass,
      mid: state.mid,
      treble: state.treble,
      beat: state.beat,
    };
  }

  /** Render one composited layer (multi-pass timeline preview). */
  renderLayer(videoFrame: VideoFrame, params: LayerRenderParams): void {
    this.renderLayers([{ videoFrame, params }]);
  }

  /**
   * Draw one or more video layers in a single command buffer.
   * PiP stacks share one submit; each layer has its own uniform buffer.
   */
  renderLayers(layers: readonly LayerDraw[]): void {
    if (this.destroyed || layers.length === 0) return;

    const encoder = this.device.createCommandEncoder();
    const canvasView = this.context.getCurrentTexture().createView();

    for (let i = 0; i < layers.length; i++) {
      this.encodeLayerDraw(encoder, canvasView, layers[i], i);
    }

    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Blend a premultiplied overlay canvas (shader text fill) onto the current
   * WebGPU swapchain without a Canvas2D video copy.
   */
  blitOverlayCanvas(source: HTMLCanvasElement | OffscreenCanvas): void {
    if (this.destroyed) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width <= 0 || height <= 0) return;

    this.ensureOverlayTexture(width, height);
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture: this.overlayTexture! },
      [width, height],
    );

    const encoder = this.device.createCommandEncoder();
    const bindGroup = this.device.createBindGroup({
      layout: this.overlayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.overlaySampler },
        { binding: 1, resource: this.overlayTexture!.createView() },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.overlayPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Upload the luma-wipe mask used by the `lumaWipe` transition. Call once per
   * project load; `null` restores the built-in diagonal ramp.
   */
  setTransitionMask(
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null,
  ): void {
    if (this.destroyed) return;
    this.transitionPipelineCache.setMaskImage(source);
  }

  /**
   * Render a GPU transition between two video frames (preview + export).
   * Caller must close() both VideoFrames after this returns.
   */
  renderTransition(
    fromFrame: VideoFrame,
    toFrame: VideoFrame,
    transitionId: string,
    params: TransitionRenderParams,
  ): void {
    if (this.destroyed) return;

    renderTransitionPass(
      this.device,
      this.context,
      this.transitionPipelineCache,
      this.sampler,
      this.transitionUniformBuffer,
      this.transitionUniformData,
      fromFrame,
      toFrame,
      transitionId,
      params,
      this.canvas.width,
      this.canvas.height,
    );
  }

  /** Clear the canvas to black without sampling a video frame. */
  clearToBlack(): void {
    if (this.destroyed) return;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Apply the finishing pass chain after compositing. */
  applyFinishing(
    settings: FinishingSettings,
    opts?: { frameIndex?: number },
  ): void {
    if (this.destroyed || !isFinishingActive(settings)) return;
    this.finishingChain.apply(
      this.device,
      this.context,
      this.canvas.width,
      this.canvas.height,
      settings,
      opts,
    );
  }

  /** Clear temporal finishing buffers after seek or clip change. */
  resetFinishingTemporal(): void {
    if (this.destroyed) return;
    this.finishingChain.resetTemporal();
  }

  /** @deprecated Use applyFinishing() — kept for callers not yet migrated. */
  applyColorGrade(settings: ColorGradeSettings): void {
    this.applyFinishing({
      lut: {
        enabled: isColorGradeActive(settings),
        lutId: settings.lutId,
        intensity: settings.intensity,
        ...(settings.customCubeText ? { customCubeText: settings.customCubeText } : {}),
        ...(settings.customFileName ? { customFileName: settings.customFileName } : {}),
      },
    });
  }

  /**
   * Wait until submitted GPU work has landed in the canvas swapchain.
   * Required before `new VideoFrame(canvas)` / VideoEncoder so export does not
   * capture a stale or partially drawn buffer.
   */
  async flush(): Promise<void> {
    if (this.destroyed) return;
    const done = this.device.queue.onSubmittedWorkDone?.();
    if (done) await done;
  }

  /**
   * Releases this engine's own buffers/textures. Does NOT destroy the
   * (shared) `GPUDevice` — that is owned by `gpuDevice.ts` and used by other
   * subsystems (text fill, other preview instances).
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniformBuffer.destroy();
    this.transitionUniformBuffer.destroy();
    this.transitionPipelineCache.destroy();
    this.finishingChain.destroy();
    this.overlayTexture?.destroy();
    for (const buffer of this.extraLayerUniformBuffers) {
      buffer.destroy();
    }
    this.extraLayerUniformBuffers = [];
    this.overlayTexture = null;
  }

  private uniformBufferForLayer(index: number): GPUBuffer {
    if (index === 0) return this.uniformBuffer;
    const extraIndex = index - 1;
    while (this.extraLayerUniformBuffers.length <= extraIndex) {
      this.extraLayerUniformBuffers.push(
        this.device.createBuffer({
          size: UNIFORM_FLOATS * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }
    return this.extraLayerUniformBuffers[extraIndex];
  }

  private encodeLayerDraw(
    encoder: GPUCommandEncoder,
    canvasView: GPUTextureView,
    layer: LayerDraw,
    index: number,
  ): void {
    const params = layer.params;
    const dest = params.destRect ?? { x: 0, y: 0, w: 1, h: 1 };
    this.uniformData[0] = params.fadeIn;
    this.uniformData[1] = params.fadeOut;
    this.uniformData[2] = params.duration;
    this.uniformData[3] = params.elapsed;
    this.uniformData[4] = params.opacity;
    this.uniformData[5] = params.uvScale[0];
    this.uniformData[6] = params.uvScale[1];
    this.uniformData[7] = params.uvOffset[0];
    this.uniformData[8] = params.uvOffset[1];
    this.uniformData[9] = dest.x;
    this.uniformData[10] = dest.y;
    this.uniformData[11] = dest.w;
    this.uniformData[12] = dest.h;
    this.uniformData[AUDIO_UNIFORM_OFFSET.bass] = this.audioReactive.bass;
    this.uniformData[AUDIO_UNIFORM_OFFSET.mid] = this.audioReactive.mid;
    this.uniformData[AUDIO_UNIFORM_OFFSET.treble] = this.audioReactive.treble;
    this.uniformData[AUDIO_UNIFORM_OFFSET.beat] = this.audioReactive.beat;
    const stab = params.stabMatrix ?? IDENTITY_STAB_MATRIX;
    this.uniformData[STAB_UNIFORM_OFFSET] = stab[0];
    this.uniformData[STAB_UNIFORM_OFFSET + 1] = stab[1];
    this.uniformData[STAB_UNIFORM_OFFSET + 2] = stab[2];
    this.uniformData[STAB_UNIFORM_OFFSET + 3] = stab[3];
    this.uniformData[STAB_UNIFORM_OFFSET + 4] = stab[4];
    this.uniformData[STAB_UNIFORM_OFFSET + 5] = stab[5];

    const uniformBuffer = this.uniformBufferForLayer(index);
    this.device.queue.writeBuffer(uniformBuffer, 0, this.uniformData);

    const externalTexture = this.device.importExternalTexture({
      source: layer.videoFrame,
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: uniformBuffer } },
      ],
    });

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: canvasView,
          loadOp: params.clear ? "clear" : "load",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  private ensureOverlayTexture(width: number, height: number): void {
    if (
      this.overlayTexture &&
      this.overlayWidth === width &&
      this.overlayHeight === height
    ) {
      return;
    }
    this.overlayTexture?.destroy();
    this.overlayTexture = this.device.createTexture({
      size: [width, height, 1],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.overlayWidth = width;
    this.overlayHeight = height;
  }
}
