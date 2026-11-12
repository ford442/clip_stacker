/**
 * HDR10 titles / captions: upload the 2D text canvas and composite it onto
 * the scene-linear working texture before the output transform (see
 * `finishing/hdrGraphics.ts` for the maths and the CPU reference). The
 * overlay texture is reallocated only when the frame size changes.
 */

import shader from './shaders/graphicsOverlay.wgsl?raw';
import { REC709_TO_REC2020 } from '../finishing/colorManagement';

/** What the HDR graphics pass can upload: a transparent 2D text canvas. */
export type GraphicsOverlaySource = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

const UNIFORM_FLOATS = 16;

/** Pack `GraphicsUniforms` (gain, then the Rec.709 → Rec.2020 rows). */
export function packGraphicsOverlayUniforms(
  gain: number,
  out: Float32Array = new Float32Array(UNIFORM_FLOATS),
): Float32Array {
  const m = REC709_TO_REC2020;
  out.fill(0);
  out[0] = gain;
  out.set([m[0], m[1], m[2]], 4);
  out.set([m[3], m[4], m[5]], 8);
  out.set([m[6], m[7], m[8]], 12);
  return out;
}

const PREMULTIPLIED_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export class GraphicsOverlayPass {
  private texture: GPUTexture | null = null;
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);

  private constructor(
    private readonly pipeline: GPURenderPipeline,
    private readonly uniformBuffer: GPUBuffer,
  ) {}

  static create(device: GPUDevice, targetFormat: GPUTextureFormat): GraphicsOverlayPass {
    const module = device.createShaderModule({ code: shader });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: targetFormat, blend: PREMULTIPLIED_OVER }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return new GraphicsOverlayPass(pipeline, uniformBuffer);
  }

  /**
   * Upload `source` (premultiplied, as the overlay blit does) and draw it over
   * `target` with sRGB white at `gain` in scene-linear units.
   */
  composite(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    source: GraphicsOverlaySource,
    target: GPUTextureView,
    width: number,
    height: number,
    gain: number,
  ): void {
    if (!this.texture || this.texture.width !== width || this.texture.height !== height) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: this.texture, premultipliedAlpha: true },
      [width, height],
    );
    packGraphicsOverlayUniforms(gain, this.uniformData);
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    const bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.texture.createView() },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.uniformBuffer.destroy();
  }
}
