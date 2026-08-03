/**
 * Ordered finishing pass chain — runs after compositing on WebGPU preview/export.
 *
 * Pass order: noise reduction → primary color → secondary color → LUT → sharpen → grain.
 * Only the LUT pass is implemented today; other slots are no-ops until their effect issues land.
 */

import { LutPass } from './lutPass';
import type { FinishingSettings } from '../utils/finishing';
import {
  isFinishingActive,
  isGrainActive,
  isLutFinishingPassActive,
  isNoiseReductionActive,
  isPrimaryColorActive,
  isSecondaryColorActive,
  isSharpenActive,
  lutPassToColorGrade,
} from '../utils/finishing';
import { resolveLutData } from '../utils/lut';

export class FinishingPassChain {
  private readonly lutPass: LutPass;
  private pingTexture: GPUTexture | null = null;
  private pongTexture: GPUTexture | null = null;
  /** Previous frame for temporal denoise — cleared on seek via resetTemporal(). */
  private prevFrameTexture: GPUTexture | null = null;
  private textureWidth = 0;
  private textureHeight = 0;

  private constructor(lutPass: LutPass) {
    this.lutPass = lutPass;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): FinishingPassChain {
    return new FinishingPassChain(LutPass.create(device, format));
  }

  /**
   * Apply enabled finishing passes in professional order to the current canvas.
   */
  apply(
    device: GPUDevice,
    context: GPUCanvasContext,
    width: number,
    height: number,
    settings: FinishingSettings,
  ): void {
    if (!isFinishingActive(settings) || width <= 0 || height <= 0) return;

    const canvasTexture = context.getCurrentTexture();
    this.ensurePingPongTextures(device, width, height);

    // Copy composited frame into ping buffer.
    const seedEncoder = device.createCommandEncoder();
    seedEncoder.copyTextureToTexture(
      { texture: canvasTexture },
      { texture: this.pingTexture! },
      [width, height, 1],
    );
    device.queue.submit([seedEncoder.finish()]);

    let current = this.pingTexture!;
    let next = this.pongTexture!;
    let wroteToCanvas = false;

    const runPass = (fn: () => void) => {
      fn();
      const swap = current;
      current = next;
      next = swap;
    };

    if (isNoiseReductionActive(settings.noiseReduction)) {
      // TODO(noise-reduction): spatial + optional temporal denoise pass.
      // When temporal is enabled, read/write prevFrameTexture and swap each frame.
      void settings.noiseReduction?.temporal;
      void this.prevFrameTexture;
    }

    if (isPrimaryColorActive(settings.primaryColor)) {
      // TODO(primary-color): primary color correction pass.
    }

    if (isSecondaryColorActive(settings.secondaryColor)) {
      // TODO(secondary-color): selective color pass.
    }

    if (isLutFinishingPassActive(settings.lut)) {
      const lut = resolveLutData(lutPassToColorGrade(settings.lut));
      if (lut) {
        this.lutPass.setLut(device, lut);
        const intensity = settings.lut!.intensity;
        const isLastGpuPass =
          !isSharpenActive(settings.sharpen) && !isGrainActive(settings.grain);

        if (isLastGpuPass) {
          this.lutPass.applyBetweenTextures(
            device,
            current,
            canvasTexture.createView(),
            width,
            height,
            intensity,
          );
          wroteToCanvas = true;
        } else {
          runPass(() => {
            this.lutPass.applyBetweenTextures(
              device,
              current,
              next.createView(),
              width,
              height,
              intensity,
            );
          });
        }
      }
    }

    if (isSharpenActive(settings.sharpen)) {
      // TODO(sharpen): detail enhancement pass.
      if (!isGrainActive(settings.grain)) {
        this.blitToCanvas(device, current, canvasTexture, width, height);
        wroteToCanvas = true;
      }
    }

    if (isGrainActive(settings.grain)) {
      // TODO(grain): film grain pass (always last).
      this.blitToCanvas(device, current, canvasTexture, width, height);
      wroteToCanvas = true;
    }

    if (!wroteToCanvas && current !== this.pingTexture) {
      this.blitToCanvas(device, current, canvasTexture, width, height);
    }
  }

  /** Clear temporal buffers after timeline seek or clip change. */
  resetTemporal(): void {
    this.prevFrameTexture?.destroy();
    this.prevFrameTexture = null;
  }

  destroy(): void {
    this.pingTexture?.destroy();
    this.pongTexture?.destroy();
    this.prevFrameTexture?.destroy();
    this.lutPass.destroy();
    this.pingTexture = null;
    this.pongTexture = null;
    this.prevFrameTexture = null;
  }

  private blitToCanvas(
    device: GPUDevice,
    source: GPUTexture,
    canvasTexture: GPUTexture,
    width: number,
    height: number,
  ): void {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: source },
      { texture: canvasTexture },
      [width, height, 1],
    );
    device.queue.submit([encoder.finish()]);
  }

  private ensurePingPongTextures(
    device: GPUDevice,
    width: number,
    height: number,
  ): void {
    if (
      this.pingTexture &&
      this.textureWidth === width &&
      this.textureHeight === height
    ) {
      return;
    }
    this.pingTexture?.destroy();
    this.pongTexture?.destroy();
    this.resetTemporal();

    const descriptor: GPUTextureDescriptor = {
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    };
    this.pingTexture = device.createTexture(descriptor);
    this.pongTexture = device.createTexture(descriptor);
    this.textureWidth = width;
    this.textureHeight = height;
  }
}
