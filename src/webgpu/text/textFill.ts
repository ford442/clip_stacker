/**
 * WebGPU text fill renderer.
 *
 * Takes a glyph mask (Canvas or ImageBitmap where bright pixels = inside letters)
 * and a shader id + params, and produces a same-sized canvas with procedural
 * color inside the glyphs (transparent elsewhere). The box background is drawn
 * separately by callers.
 *
 * The WGSL and uniforms are designed so that the same shader code path is used
 * for both live preview and GPU export frames.
 *
 * The result stays on the GPU end-to-end: the output canvas holds a `webgpu`
 * context and the render pass draws directly into its current texture, so
 * there is no `copyTextureToBuffer` / `mapAsync` readback and no per-pixel JS
 * color conversion. Callers still get back a drawable `HTMLCanvasElement`
 * (`ctx.drawImage(canvas, ...)` works against a WebGPU-backed canvas).
 */

import textFillShader from '../shaders/textFill.wgsl?raw';
import { acquireGpuContext } from '../gpuDevice';
import { ffmpegColorToRgb01 } from '../../utils/color';
import { getTextShader, resolveShaderColors, resolveShaderParams } from './registry';

export interface UniformSlots {
  p0: number;
  p1: number;
  p2: number;
  mode: number;
}

export interface ColorUniformSlots {
  c0: [number, number, number];
  c1: [number, number, number];
  c2: [number, number, number];
}

/**
 * Resolve a shader's named params into uniform slots p0..p2 (+ mode) using
 * its declarative `paramSlots`/`mode` from the registry. Pure and
 * GPU-independent so it's unit-testable, and the only place that needs to
 * change when a shader's param set changes — never `render()` itself.
 */
export function mapParamsToUniformSlots(
  shaderId: string | undefined | null,
  params?: Record<string, number>,
): UniformSlots {
  const shaderDef = getTextShader(shaderId);
  const resolved = resolveShaderParams(shaderId, params);
  const slots: UniformSlots = { p0: 0, p1: 0, p2: 0, mode: shaderDef?.mode ?? 0 };
  if (!shaderDef) return slots;
  for (const [key, slot] of Object.entries(shaderDef.paramSlots)) {
    const value = resolved[key];
    if (value === undefined) continue;
    if (slot === 0) slots.p0 = value;
    else if (slot === 1) slots.p1 = value;
    else slots.p2 = value;
  }
  return slots;
}

/** Resolve shader color keys into uniform slots c0..c2. */
export function mapColorsToUniformSlots(
  shaderId: string | undefined | null,
  colors?: Record<string, string>,
): ColorUniformSlots {
  const shaderDef = getTextShader(shaderId);
  const resolved = resolveShaderColors(shaderId, colors);
  const slots: ColorUniformSlots = {
    c0: [1, 1, 1],
    c1: [1, 1, 1],
    c2: [1, 1, 1],
  };
  if (!shaderDef?.colorSlots) return slots;
  for (const [key, slot] of Object.entries(shaderDef.colorSlots)) {
    const raw = resolved[key];
    if (!raw) continue;
    const rgb = ffmpegColorToRgb01(raw);
    if (slot === 0) slots.c0 = rgb;
    else if (slot === 1) slots.c1 = rgb;
    else slots.c2 = rgb;
  }
  return slots;
}

export interface TextFillOptions {
  time: number;
  shaderId?: string;
  params?: Record<string, number>;
  colors?: Record<string, string>;
  /** Target size; if omitted, derived from mask. */
  width?: number;
  height?: number;
  /**
   * Stable identity for the glyph raster (text, font, size, resolved
   * position, scroll offset — whatever determines `mask`'s pixels). When two
   * consecutive calls pass the same key, the mask texture and bind group are
   * reused instead of re-uploaded — a static caption's mask never changes,
   * only `time` does. Omit to always re-upload (safe default).
   */
  maskCacheKey?: string;
}

const UNIFORM_FLOAT_COUNT = 20;

export class TextFillRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);
  private readonly format: GPUTextureFormat;
  private readonly outputCanvas: HTMLCanvasElement;
  private context: GPUCanvasContext | null = null;
  private canvasWidth = 0;
  private canvasHeight = 0;

  private maskTex: GPUTexture | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private maskWidth = 0;
  private maskHeight = 0;
  private cachedMaskKey: string | null = null;

  private destroyed = false;

  private constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
    format: GPUTextureFormat,
    outputCanvas: HTMLCanvasElement,
  ) {
    this.device = device;
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
    this.format = format;
    this.outputCanvas = outputCanvas;
  }

  static async create(): Promise<TextFillRenderer> {
    const { device } = await acquireGpuContext();
    const format = navigator.gpu.getPreferredCanvasFormat();

    const shaderModule = device.createShaderModule({ code: textFillShader });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOAT_COUNT * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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

    const canvas = document.createElement('canvas');
    return new TextFillRenderer(device, pipeline, sampler, uniformBuffer, format, canvas);
  }

  /** (Re)configure the output canvas's `webgpu` context for the requested size. */
  private ensureCanvasContext(width: number, height: number): GPUCanvasContext {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (this.context && this.canvasWidth === w && this.canvasHeight === h) {
      return this.context;
    }
    this.canvasWidth = w;
    this.canvasHeight = h;
    this.outputCanvas.width = w;
    this.outputCanvas.height = h;
    const context = this.outputCanvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('Could not acquire a WebGPU canvas context');
    context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
    this.context = context;
    return context;
  }

  /** Upload `mask` as the bound texture, unless `cacheKey` matches the already-bound one. */
  private ensureMaskBinding(
    mask: HTMLCanvasElement | OffscreenCanvas,
    width: number,
    height: number,
    cacheKey: string | undefined,
  ): GPUBindGroup {
    const reusable =
      cacheKey !== undefined &&
      cacheKey === this.cachedMaskKey &&
      this.maskTex !== null &&
      this.bindGroup !== null &&
      this.maskWidth === width &&
      this.maskHeight === height;
    if (reusable) return this.bindGroup!;

    this.maskTex?.destroy();
    this.maskWidth = width;
    this.maskHeight = height;
    this.maskTex = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: mask as unknown as GPUCopyExternalImageSource },
      { texture: this.maskTex },
      { width, height },
    );

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.maskTex.createView() },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    this.cachedMaskKey = cacheKey ?? null;
    return this.bindGroup;
  }

  /** Write time + shader params/colors into the uniform buffer. */
  private writeUniforms(width: number, height: number, opts: TextFillOptions): void {
    const slots = mapParamsToUniformSlots(opts.shaderId, opts.params);
    const colors = mapColorsToUniformSlots(opts.shaderId, opts.colors);

    this.uniformData[0] = opts.time ?? 0;
    this.uniformData[1] = width;
    this.uniformData[2] = height;
    this.uniformData[3] = 0;
    this.uniformData[4] = slots.p0;
    this.uniformData[5] = slots.p1;
    this.uniformData[6] = slots.p2;
    this.uniformData[7] = slots.mode;
    this.uniformData[8] = colors.c0[0];
    this.uniformData[9] = colors.c0[1];
    this.uniformData[10] = colors.c0[2];
    this.uniformData[11] = 1;
    this.uniformData[12] = colors.c1[0];
    this.uniformData[13] = colors.c1[1];
    this.uniformData[14] = colors.c1[2];
    this.uniformData[15] = 1;
    this.uniformData[16] = colors.c2[0];
    this.uniformData[17] = colors.c2[1];
    this.uniformData[18] = colors.c2[2];
    this.uniformData[19] = 1;
    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      this.uniformData.buffer,
      this.uniformData.byteOffset,
      UNIFORM_FLOAT_COUNT * 4,
    );
  }

  /**
   * Render the shader fill for the given mask. Returns a canvas containing the
   * result (same size as mask unless overridden). The result has premultiplied
   * alpha and is transparent outside glyphs.
   */
  async render(
    mask: HTMLCanvasElement | OffscreenCanvas,
    opts: TextFillOptions,
  ): Promise<HTMLCanvasElement> {
    if (this.destroyed) throw new Error('TextFillRenderer destroyed');

    const mw = mask.width || 1;
    const mh = mask.height || 1;
    const tw = opts.width ?? mw;
    const th = opts.height ?? mh;

    const context = this.ensureCanvasContext(tw, th);
    const bindGroup = this.ensureMaskBinding(mask, mw, mh, opts.maskCacheKey);
    this.writeUniforms(tw, th, opts);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, 1, 0, 0);
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    return this.outputCanvas;
  }

  /** Releases this renderer's own textures/buffers. The shared `GPUDevice` is untouched. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.maskTex?.destroy(); } catch {}
    try { this.uniformBuffer?.destroy(); } catch {}
  }
}

let cached: TextFillRenderer | null = null;

export async function getTextFillRenderer(): Promise<TextFillRenderer> {
  if (cached && !cached['destroyed']) return cached;
  cached = await TextFillRenderer.create();
  return cached;
}
