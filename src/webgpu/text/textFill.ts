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
 */

import textFillShader from '../shaders/textFill.wgsl?raw';
import { getTextShader, resolveShaderParams } from './registry';

export interface TextFillOptions {
  time: number;
  shaderId?: string;
  params?: Record<string, number>;
  /** Target size; if omitted, derived from mask. */
  width?: number;
  height?: number;
}

export class TextFillRenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private uniformData = new Float32Array(8);
  private outputCanvas: HTMLCanvasElement;
  private outputCtx: CanvasRenderingContext2D | null = null;
  private destroyed = false;

  private constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuffer: GPUBuffer,
    outputCanvas: HTMLCanvasElement,
  ) {
    this.device = device;
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuffer = uniformBuffer;
    this.outputCanvas = outputCanvas;
    this.outputCtx = outputCanvas.getContext('2d');
  }

  static async create(): Promise<TextFillRenderer> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable for text fills');
    const device = await adapter.requestDevice();

    const shaderModule = device.createShaderModule({ code: textFillShader });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    const uniformBuffer = device.createBuffer({
      size: 8 * 4,
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
        targets: [{ format: 'bgra8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const canvas = document.createElement('canvas');
    // size set per render
    return new TextFillRenderer(device, pipeline, sampler, uniformBuffer, canvas);
  }

  private ensureSize(width: number, height: number): GPUTexture {
    if (this.outputCanvas.width !== width || this.outputCanvas.height !== height) {
      this.outputCanvas.width = Math.max(1, width);
      this.outputCanvas.height = Math.max(1, height);
    }
    // Create a texture to render into, then copy to canvas via copyExternalImage or readback.
    // Simpler: render directly to a texture, then copy to the 2D canvas using copyExternalImageToTexture? For broad support we read via a staging or draw via bitmap.
    // Practical path: render to a texture, then use a temporary 2D canvas and putImageData after reading, or use device to draw.
    // Easiest portable: render to a texture, then create ImageBitmap from a 2D canvas that we draw the texture into? We use a different approach:
    // Render using a GPUCanvasContext on our outputCanvas (if possible) or use copyTextureToBuffer + putImageData.
    // For simplicity and compatibility, render into an offscreen texture and blit using Canvas 2D after converting via drawImage on a temp video? No.
    // Better: attach a GPUCanvasContext to the outputCanvas for 'webgpu' and render directly to it.
    // But some browsers may not allow switching. We create a separate texture target and use copyExternalImageToTexture from texture? Actually simplest reliable:
    // Create a texture, render to it, then use copyTextureToBuffer and putImageData.
    // To keep code short, we render to the canvas via its WebGPU context if available, else fallback path.
    // Here we use context configuration for 'bgra8unorm' on the canvas.
    return this.ensureTargetTexture(width, height);
  }

  private targetTexture: GPUTexture | null = null;
  private targetView: GPUTextureView | null = null;
  private targetWidth = 0;
  private targetHeight = 0;

  private ensureTargetTexture(width: number, height: number): GPUTexture {
    if (
      !this.targetTexture ||
      this.targetWidth !== width ||
      this.targetHeight !== height
    ) {
      this.targetTexture?.destroy();
      this.targetWidth = Math.max(1, width);
      this.targetHeight = Math.max(1, height);
      this.targetTexture = this.device.createTexture({
        size: { width: this.targetWidth, height: this.targetHeight, depthOrArrayLayers: 1 },
        format: 'bgra8unorm',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.TEXTURE_BINDING,
      });
      this.targetView = this.targetTexture.createView();
      // Also size the 2D canvas for final readback blitting
      this.outputCanvas.width = this.targetWidth;
      this.outputCanvas.height = this.targetHeight;
    }
    return this.targetTexture;
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

    const mw = mask.width || (mask as HTMLCanvasElement).width || 1;
    const mh = mask.height || (mask as HTMLCanvasElement).height || 1;
    const tw = opts.width ?? mw;
    const th = opts.height ?? mh;

    const target = this.ensureTargetTexture(tw, th);

    // Upload mask as texture
    const maskTex = this.device.createTexture({
      size: { width: mw, height: mh, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Copy from 2D canvas to GPU texture
    this.device.queue.copyExternalImageToTexture(
      { source: mask as any },
      { texture: maskTex },
      { width: mw, height: mh },
    );

    // Uniforms
    const shader = getTextShader(opts.shaderId);
    const params = resolveShaderParams(opts.shaderId, opts.params);
    // Map common param names to p0..p3; unknown keys ignored for v1
    const p = [0, 0, 0, 0];
    const keys = Object.keys(params);
    // gradient: speed, angle; plasma: scale, speed
    if (keys.includes('speed')) p[0] = params.speed ?? p[0];
    if (keys.includes('angle')) p[1] = params.angle ?? p[1];
    if (keys.includes('scale')) p[0] = params.scale ?? p[0];
    if (keys.includes('speed') && opts.shaderId === 'plasma') p[1] = params.speed ?? p[1];
    // mode via p3: 0 gradient, 1 plasma
    p[3] = opts.shaderId === 'plasma' ? 1 : 0;

    this.uniformData[0] = opts.time ?? 0;
    this.uniformData[1] = tw;
    this.uniformData[2] = th;
    this.uniformData[4] = p[0];
    this.uniformData[5] = p[1];
    this.uniformData[6] = p[2];
    this.uniformData[7] = p[3];
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer, this.uniformData.byteOffset, 8 * 4);

    const maskView = maskTex.createView();
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: maskView },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
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

    // Copy target to a readable buffer then to 2D canvas via ImageData
    const bytesPerRow = Math.ceil((tw * 4) / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * th,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer, bytesPerRow, rowsPerImage: th },
      { width: tw, height: th },
    );
    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buffer.getMappedRange());
    // 'bgra8unorm' storage -> RGBA for ImageData (texture row 0 is top, matches canvas)
    const rgba = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const si = y * bytesPerRow + x * 4;
        const di = (y * tw + x) * 4;
        rgba[di + 0] = data[si + 2]; // R <- B from BGRA
        rgba[di + 1] = data[si + 1]; // G
        rgba[di + 2] = data[si + 0]; // B <- R from BGRA
        rgba[di + 3] = data[si + 3]; // A
      }
    }
    buffer.unmap();
    maskTex.destroy();

    // Write to our output canvas
    const outW = tw;
    const outH = th;
    if (this.outputCanvas.width !== outW || this.outputCanvas.height !== outH) {
      this.outputCanvas.width = outW;
      this.outputCanvas.height = outH;
    }
    const octx = this.outputCanvas.getContext('2d', { willReadFrequently: true })!;
    octx.clearRect(0, 0, outW, outH);
    const img = new ImageData(rgba, outW, outH);
    octx.putImageData(img, 0, 0);

    return this.outputCanvas;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.targetTexture?.destroy(); } catch {}
    try { this.uniformBuffer?.destroy(); } catch {}
    try { this.device?.destroy(); } catch {}
  }
}

let cached: TextFillRenderer | null = null;

export async function getTextFillRenderer(): Promise<TextFillRenderer> {
  if (cached && !cached['destroyed']) return cached;
  cached = await TextFillRenderer.create();
  return cached;
}
