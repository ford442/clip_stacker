/**
 * The two private textures `PreviewEngine` keeps beside its swapchain: the
 * premultiplied 2D overlay it blends on (shader text fill), and the copy of
 * the composed frame the gpu-chores scopes read. Each is reallocated only
 * when the frame size (or format) changes.
 */

import { OVERLAY_TEXTURE_PREMULTIPLIED } from "./overlayBlit";
import { GPU_TEX_COPY_DST, GPU_TEX_TEXTURE_BINDING } from "./canvasConfiguration";

export class OverlayBlitter {
  private texture: GPUTexture | null = null;

  /** Blend premultiplied `source` (source-over) onto `target`. */
  blit(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    format: GPUTextureFormat,
    source: HTMLCanvasElement | OffscreenCanvas,
    target: GPUTexture,
    width: number,
    height: number,
  ): void {
    if (
      !this.texture ||
      this.texture.width !== width ||
      this.texture.height !== height ||
      this.texture.format !== format
    ) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        size: [width, height, 1],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    // The blend is premultiplied source-over, so the texture must hold
    // premultiplied colour; the default (`false`) un-premultiplies and haloes
    // every anti-aliased edge (see overlayBlit.ts).
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: this.texture, premultipliedAlpha: OVERLAY_TEXTURE_PREMULTIPLIED },
      [width, height],
    );

    const encoder = device.createCommandEncoder();
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: this.texture.createView() },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
  }
}

export class ScopeTextureCopy {
  private texture: GPUTexture | null = null;

  get size(): { width: number; height: number } {
    return { width: this.texture?.width ?? 0, height: this.texture?.height ?? 0 };
  }

  /**
   * Copy `source` (the swapchain texture) into the private texture; null when
   * the swapchain texture was already presented or the device is gone.
   */
  capture(device: GPUDevice, source: () => GPUTexture, format: GPUTextureFormat, width: number, height: number): GPUTexture | null {
    if (
      !this.texture ||
      this.texture.width !== width ||
      this.texture.height !== height ||
      this.texture.format !== format
    ) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        size: { width, height },
        format,
        usage: GPU_TEX_COPY_DST | GPU_TEX_TEXTURE_BINDING,
      });
    }
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: source() }, { texture: this.texture }, { width, height });
      device.queue.submit([encoder.finish()]);
    } catch {
      // Swapchain texture already presented (or device lost) — skip this
      // frame's scopes rather than failing the render.
      return null;
    }
    return this.texture;
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
  }
}
