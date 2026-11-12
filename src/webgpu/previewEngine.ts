import {
  acquireGpuContext,
  assertPreviewAdapter,
  onGpuDeviceRecovered,
  type GpuContext,
} from "./gpuDevice";
import {
  renderTransitionPass,
  TRANSITION_UNIFORM_FLOATS,
  type TransitionPipelineCache,
} from "./transitions/transitionPass";
import type { TransitionRenderParams } from "./transitions/types";
import type { FinishingPassChain } from "./finishingPassChain";
import {
  DEFAULT_COLOR_MANAGEMENT,
  importColorSpaceFor,
  isColorManagementActive,
  normalizeColorManagement,
  planCanvasSurface,
  publishColorDebugSnapshot,
  resolveCanvasPresentation,
  type CanvasColorRequest,
  type CanvasPresentation,
  type CanvasSurface,
  type ColorManagementSettings,
} from "../finishing/colorManagement";
import { adoptGpuDevice } from "../gpu-chores/device";
import { isFinishingActive, type FinishingSettings } from "../finishing/finishing";
import {
  ZERO_AUDIO_REACTIVE,
  type AudioReactiveState,
} from "../wasm/audioReactiveUniforms";
import {
  packLayerUniforms,
  UNIFORM_FLOATS,
  type LayerDraw,
  type LayerRenderParams,
} from "./previewLayerUniforms";
import { buildPreviewDeviceResources } from "./previewDeviceResources";
import { canvasConfiguration } from "./canvasConfiguration";
import { OverlayBlitter, ScopeTextureCopy } from "./previewCanvasCopies";
import { Hdr10FrameReader, type PackedFrameInit } from "./hdr10FrameReader";
import type { GraphicsOverlaySource } from "./graphicsOverlayPass";
import { readPqTextureAsRgba8 } from "./pqReadback";
import { gpuProfilerFor } from "./gpuProfiler";

export interface PreviewEngineOptions {
  /**
   * `display` (default) is an on-screen preview; `offscreen` only feeds an
   * encoder or a readback (export, harness), so HDR10 composites on a float
   * canvas regardless of the monitor.
   */
  surface?: CanvasSurface;
}

export type {
  LayerDraw,
  LayerRenderParams,
  
} from "./previewLayerUniforms";

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
  private readonly overlayBlitter = new OverlayBlitter();
  private readonly scopeCopy = new ScopeTextureCopy();
  private destroyed = false;
  private audioReactive: AudioReactiveState = { ...ZERO_AUDIO_REACTIVE };
  /** Swapchain (= compositing) format: the device's preferred one, or rgba16float for HDR. */
  private format: GPUTextureFormat;
  private preferredFormat: GPUTextureFormat;
  private surface: CanvasSurface = "display";
  private displayHdr = false;
  /** What `importExternalTexture` converts sources to (P3 when managed). */
  private importColorSpace: PredefinedColorSpace = "srgb";
  private hdr10Reader: Hdr10FrameReader | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private unsubscribeRecovered: (() => void) | null = null;
  private colorManagement: ColorManagementSettings = { ...DEFAULT_COLOR_MANAGEMENT };
  private presentation: CanvasPresentation = {
    colorSpace: "srgb",
    toneMapping: "standard",
    present: "identity",
    presentFallback: false,
  };

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
    this.preferredFormat = format;
    this.canvas = { width: 0, height: 0 } as unknown as OffscreenCanvas;
  }

  /**
   * Reconfigure the WebGPU canvas context after the canvas element is resized.
   * Without this, getCurrentTexture() may continue to serve the old size.
   */
  resize(): void {
    if (this.destroyed) return;
    this.configureCanvas();
  }

  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: PreviewEngineOptions = {},
  ): Promise<PreviewEngine> {
    const gpu = await acquireGpuContext();
    const { device, format } = gpu;
    // Live preview on SwiftShader / WARP would crawl; export may still use it.
    if ((options.surface ?? "display") === "display") assertPreviewAdapter(gpu);

    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw new Error("Could not get WebGPU context from canvas");

    context.configure(canvasConfiguration(device, format));

    const built = buildPreviewDeviceResources(device, format);

    const engine = new PreviewEngine(
      device,
      context,
      built.pipeline,
      built.sampler,
      built.uniformBuffer,
      built.transitionUniformBuffer,
      built.transitionPipelineCache,
      built.finishingChain,
      built.overlayPipeline,
      built.overlaySampler,
      format,
    );
    engine.canvas = canvas;
    engine.surface = options.surface ?? "display";
    adoptGpuDevice(device);
    engine.unsubscribeRecovered = onGpuDeviceRecovered((ctx) => engine.handleDeviceRecovered(ctx));
    return engine;
  }

  /**
   * A device loss strands this engine's pipelines/buffers/context on a dead
   * device. Some callers tear the whole engine down on `onGpuDeviceLost` and
   * build a fresh one later (the shared registry already has the recovered
   * device by then, so nothing more is needed there); this covers any
   * `PreviewEngine` that instead stays alive across the loss — without this,
   * its `context` would remain configured against a destroyed device and
   * every subsequent frame would silently no-op onto a black canvas.
   */
  private handleDeviceRecovered(ctx: GpuContext): void {
    if (this.destroyed || ctx.device === this.device) return;
    this.preferredFormat = ctx.format;
    this.rebuildDeviceResources(ctx.device, this.surfacePlan().format);
    this.configureCanvas();
  }

  /**
   * Drop every device- or format-bound object and build them again for
   * `device` / `format`. Device recovery and a swapchain format change (HDR
   * on / off) both come through here.
   */
  private rebuildDeviceResources(device: GPUDevice, format: GPUTextureFormat): void {
    this.uniformBuffer.destroy();
    this.transitionUniformBuffer.destroy();
    this.transitionPipelineCache.destroy();
    this.finishingChain.destroy();
    this.overlayBlitter.destroy();
    this.scopeCopy.destroy();
    this.hdr10Reader?.destroy();
    this.hdr10Reader = null;
    for (const buffer of this.extraLayerUniformBuffers) buffer.destroy();
    this.extraLayerUniformBuffers = [];

    const deviceChanged = device !== this.device;
    this.device = device;
    this.format = format;
    const built = buildPreviewDeviceResources(this.device, this.format);
    this.pipeline = built.pipeline;
    this.sampler = built.sampler;
    this.uniformBuffer = built.uniformBuffer;
    this.transitionUniformBuffer = built.transitionUniformBuffer;
    this.transitionPipelineCache = built.transitionPipelineCache;
    this.finishingChain = built.finishingChain;
    this.overlayPipeline = built.overlayPipeline;
    this.overlaySampler = built.overlaySampler;
    if (deviceChanged) adoptGpuDevice(this.device);
  }

  private surfacePlan() {
    return planCanvasSurface(
      this.colorManagement.outputColor,
      this.surface,
      this.displayHdr,
      this.preferredFormat,
    );
  }

  /** Rebuild for a new swapchain format when the plan changed it, then configure. */
  private applySurfacePlan(): void {
    const plan = this.surfacePlan();
    if (plan.format !== this.format) this.rebuildDeviceResources(this.device, plan.format);
    this.configureCanvas();
  }

  /**
   * Apply the selected output color to the swapchain. Display P3 and extended
   * HDR are attempted and, on failure, the canvas falls back to the preferred
   * format in sRGB / standard.
   */
  private configureCanvas(): void {
    const plan = this.surfacePlan();
    const request: CanvasColorRequest = { colorSpace: plan.colorSpace, toneMapping: plan.toneMapping };
    const isDefault =
      request.colorSpace === "srgb" &&
      request.toneMapping === "standard" &&
      this.format === this.preferredFormat;
    let configured = request;
    try {
      this.context.configure({
        ...canvasConfiguration(this.device, this.format),
        colorSpace: request.colorSpace,
        toneMapping: { mode: request.toneMapping },
      });
    } catch (err) {
      if (isDefault) throw err;
      configured = { colorSpace: "srgb", toneMapping: "standard" };
      if (this.format !== this.preferredFormat) {
        this.rebuildDeviceResources(this.device, this.preferredFormat);
      }
      this.context.configure(canvasConfiguration(this.device, this.format));
    }
    this.presentation = resolveCanvasPresentation(
      this.colorManagement.outputColor,
      configured,
      this.format,
    );
    publishColorDebugSnapshot({
      outputColor: this.colorManagement.outputColor,
      workingSpace: this.colorManagement.workingSpace,
      importColorSpace: this.importColorSpace,
      displayHdr: this.displayHdr,
      canvasColorSpace: this.presentation.colorSpace,
      toneMapping: this.presentation.toneMapping,
      canvasFormat: this.format,
      present: this.presentation.present,
      presentFallback: this.presentation.presentFallback,
    });
  }

  /**
   * Reconfigure when the user changes output color or working space. Call
   * before drawing a frame: a reconfigure discards the current texture.
   */
  setColorManagement(settings: ColorManagementSettings | undefined): void {
    if (this.destroyed) return;
    const next = normalizeColorManagement(settings);
    const changed =
      next.outputColor !== this.colorManagement.outputColor ||
      next.workingSpace !== this.colorManagement.workingSpace;
    this.colorManagement = next;
    this.importColorSpace = importColorSpaceFor(next);
    if (changed) this.applySurfacePlan();
  }

  /**
   * Whether the monitor showing this canvas is HDR (`(dynamic-range: high)`,
   * resolved on main — workers have no `matchMedia`). An HDR10 project then
   * previews on an extended-range float canvas. Call before drawing a frame.
   */
  setDisplayHdr(displayHdr: boolean): void {
    if (this.destroyed || displayHdr === this.displayHdr) return;
    this.displayHdr = displayHdr;
    if (this.colorManagement.outputColor === "hdr10") this.applySurfacePlan();
  }

  get canvasPresentation(): CanvasPresentation {
    return this.presentation;
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
    const profiler = gpuProfilerFor(this.device);
    const span = profiler?.begin(encoder, "compositor") ?? null;

    for (let i = 0; i < layers.length; i++) {
      this.encodeLayerDraw(encoder, canvasView, layers[i]!, i);
    }

    profiler?.end(encoder, span);
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
    this.overlayBlitter.blit(
      this.device,
      this.overlayPipeline,
      this.overlaySampler,
      this.format,
      source,
      this.context.getCurrentTexture(),
      width,
      height,
    );
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
      {
        view: this.context.getCurrentTexture().createView(),
        importColorSpace: this.importColorSpace,
        profiler: gpuProfilerFor(this.device),
      },
    );
  }

  /**
   * Copy the composed canvas texture into a reusable offscreen texture that
   * compute shaders (the gpu-chores scopes) can sample.
   *
   * The canvas is configured swapchain-only — RENDER_ATTACHMENT | COPY_SRC — so
   * scopes never bind or copy *into* it; they read this private copy instead.
   * Must be called while the current frame's texture is still valid, i.e. in
   * the same task that drew it, before yielding to the event loop.
   *
   * Returns a borrowed texture owned by the engine: do not destroy it.
   */
  captureScopeTexture(): GPUTexture | null {
    if (this.destroyed) return null;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width <= 0 || height <= 0) return null;
    return this.scopeCopy.capture(
      this.device,
      () => this.context.getCurrentTexture(),
      this.format,
      width,
      height,
    );
  }

  /** Size of the texture `captureScopeTexture` returns. */
  get scopeTextureSize(): { width: number; height: number } {
    return this.scopeCopy.size;
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
    opts?: {
      frameIndex?: number;
      colorManagement?: ColorManagementSettings;
      /** HDR10: this frame's titles / captions (see `FinishingApplyOptions`). */
      graphicsOverlay?: GraphicsOverlaySource;
    },
  ): void {
    if (this.destroyed) return;
    if (opts?.colorManagement) this.setColorManagement(opts.colorManagement);
    const managed = isColorManagementActive(this.colorManagement);
    if (!isFinishingActive(settings) && !managed) return;
    this.finishingChain.apply(
      this.device,
      this.context,
      this.canvas.width,
      this.canvas.height,
      settings,
      {
        ...(opts?.frameIndex !== undefined ? { frameIndex: opts.frameIndex } : {}),
        colorManagement: this.colorManagement,
        presentation: this.presentation,
        importColorSpace: this.importColorSpace,
        ...(opts?.graphicsOverlay ? { graphicsOverlay: opts.graphicsOverlay } : {}),
      },
    );
  }

  /**
   * The last managed HDR10 frame as an `I420P10` `VideoFrame` (BT.2020 NCL,
   * PQ, limited range) for the encoder — packed on the GPU and read back
   * through a three-slot ring. The GPU work is recorded now; at most
   * {@link hdr10ReadbackDepth} captures may be outstanding. Caller closes the
   * frame. Rejects when no HDR10 frame was rendered.
   */
  captureHdr10Frame(init: PackedFrameInit): Promise<VideoFrame> {
    if (this.destroyed) return Promise.reject(new Error("Preview engine destroyed"));
    const texture = this.finishingChain.getPqExportTexture();
    if (!texture) return Promise.reject(new Error("No HDR10 frame has been rendered"));
    this.hdr10Reader ??= new Hdr10FrameReader(this.device);
    return this.hdr10Reader.capture(texture, init, gpuProfilerFor(this.device));
  }

  /** How many HDR10 captures may be in flight at once. */
  get hdr10ReadbackDepth(): number {
    return this.hdr10Reader?.depth ?? 3;
  }

  /**
   * Tightly packed RGBA8 of the last HDR10 PQ image (each code rounded to
   * 8 bits) — for the regression harness and debugging, not the export, which
   * reads 10-bit YUV through {@link captureHdr10Frame}. Null when this engine
   * has not rendered a managed HDR10 frame.
   */
  async readPqExportRgba(): Promise<Uint8Array | null> {
    if (this.destroyed) return null;
    const texture = this.finishingChain.getPqExportTexture();
    if (!texture) return null;
    return readPqTextureAsRgba8(this.device, texture);
  }

  /** Close this frame's GPU profile (no-op unless `?gpu_profile`). */
  endFrameProfile(): void {
    if (this.destroyed) return;
    gpuProfilerFor(this.device)?.endFrame();
  }

  /** Clear temporal finishing buffers after seek or clip change. */
  resetFinishingTemporal(): void {
    if (this.destroyed) return;
    this.finishingChain.resetTemporal();
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
    this.unsubscribeRecovered?.();
    this.unsubscribeRecovered = null;
    this.uniformBuffer.destroy();
    this.transitionUniformBuffer.destroy();
    this.transitionPipelineCache.destroy();
    this.finishingChain.destroy();
    this.overlayBlitter.destroy();
    this.scopeCopy.destroy();
    this.hdr10Reader?.destroy();
    this.hdr10Reader = null;
    for (const buffer of this.extraLayerUniformBuffers) {
      buffer.destroy();
    }
    this.extraLayerUniformBuffers = [];
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
    const sourceP3 = this.importColorSpace === "display-p3";
    const params = sourceP3 ? { ...layer.params, sourceP3 } : layer.params;
    packLayerUniforms(this.uniformData, params, this.audioReactive);

    const uniformBuffer = this.uniformBufferForLayer(index);
    this.device.queue.writeBuffer(uniformBuffer, 0, this.uniformData);

    // The browser converts from the frame's own colour tags (or the clip's
    // decoder-side override) to sRGB, or to Display P3 when managed.
    const externalTexture = this.device.importExternalTexture({
      source: layer.videoFrame,
      colorSpace: this.importColorSpace,
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
}
