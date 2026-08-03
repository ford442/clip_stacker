import previewShader from "./shaders/preview.wgsl?raw";
import { acquireGpuContext } from "./gpuDevice";
import {
  createTransitionPipelineCache,
  renderTransitionPass,
  TRANSITION_UNIFORM_FLOATS,
  type TransitionPipelineCache,
} from "./transitions/transitionPass";
import type { TransitionRenderParams } from "./transitions/types";
import { FinishingPassChain } from "./finishingPassChain";
import type { ColorGradeSettings } from "../utils/lut";
import { isColorGradeActive } from "../utils/lut";
import type { FinishingSettings } from "../utils/finishing";
import { isFinishingActive } from "../utils/finishing";
import {
  AUDIO_UNIFORM_OFFSET,
  ZERO_AUDIO_REACTIVE,
  type AudioReactiveState,
} from "../wasm/audioReactiveUniforms";

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
const UNIFORM_FLOATS = 20;

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
  /** Destination rectangle on the canvas in normalized 0–1 coordinates. */
  destRect?: NormalizedDestRect;
  /** When true, clears the canvas before drawing this layer. */
  clear?: boolean;
}

export class PreviewEngine {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private uniformData = new Float32Array(UNIFORM_FLOATS);
  private transitionUniformBuffer: GPUBuffer;
  private transitionUniformData = new Float32Array(TRANSITION_UNIFORM_FLOATS);
  private transitionPipelineCache: TransitionPipelineCache;
  private finishingChain: FinishingPassChain;
  private destroyed = false;
  private audioReactive: AudioReactiveState = { ...ZERO_AUDIO_REACTIVE };

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
    transitionUniformBuffer: GPUBuffer,
    transitionPipelineCache: TransitionPipelineCache,
    finishingChain: FinishingPassChain,
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
    this.format = format;
    // Placeholder; overwritten by the factory before the instance is returned.
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
    });
  }

  private format: GPUTextureFormat;
  private canvas: HTMLCanvasElement | OffscreenCanvas;

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<PreviewEngine> {
    const { device, format } = await acquireGpuContext();

    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw new Error("Could not get WebGPU context from canvas");

    context.configure({ device, format, alphaMode: "premultiplied" });

    const shaderModule = device.createShaderModule({ code: previewShader });

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
        targets: [
          {
            format,
            blend: {
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
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
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
      format,
    );
    engine.canvas = canvas;
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
    if (this.destroyed) return;

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
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const externalTexture = this.device.importExternalTexture({
      source: videoFrame,
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
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
    this.device.queue.submit([encoder.finish()]);
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
   * Releases this engine's own buffers/textures. Does NOT destroy the
   * (shared) `GPUDevice` — that is owned by `gpuDevice.ts` and used by other
   * subsystems (text fill, other preview instances).
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniformBuffer.destroy();
    this.transitionUniformBuffer.destroy();
    this.finishingChain.destroy();
  }
}
