/**
 * Ordered finishing pass chain — runs after compositing on WebGPU preview/export.
 *
 * Pass order: noise reduction → primary color → secondary color → LUT → sharpen → grain.
 * Primary color and LUT are implemented; other slots are no-ops until their effect issues land.
 */

import { LutPass } from './lutPass';
import { PrimaryColorGpuPass } from './primaryColorPass';
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
  private readonly primaryColorPass: PrimaryColorGpuPass;
  private pingTexture: GPUTexture | null = null;
  private pongTexture: GPUTexture | null = null;
  /** Previous frame for temporal denoise — cleared on seek via resetTemporal(). */
  private prevFrameTexture: GPUTexture | null = null;
  private textureWidth = 0;
  private textureHeight = 0;

  private constructor(lutPass: LutPass, primaryColorPass: PrimaryColorGpuPass) {
    this.lutPass = lutPass;
    this.primaryColorPass = primaryColorPass;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): FinishingPassChain {
    return new FinishingPassChain(
      LutPass.create(device, format),
      PrimaryColorGpuPass.create(device, format),
    );
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

    const hasLaterGpuPass = (
      after: 'primary' | 'secondary' | 'lut' | 'sharpen',
    ): boolean => {
      if (after === 'primary') {
        return (
          isSecondaryColorActive(settings.secondaryColor) ||
          isLutFinishingPassActive(settings.lut) ||
          isSharpenActive(settings.sharpen) ||
          isGrainActive(settings.grain)
        );
      }
      if (after === 'secondary') {
        return (
          isLutFinishingPassActive(settings.lut) ||
          isSharpenActive(settings.sharpen) ||
          isGrainActive(settings.grain)
        );
      }
      if (after === 'lut') {
        return isSharpenActive(settings.sharpen) || isGrainActive(settings.grain);
      }
      return isGrainActive(settings.grain);
    };

    if (isNoiseReductionActive(settings.noiseReduction)) {
      // TODO(noise-reduction): spatial + optional temporal denoise pass.
      // When temporal is enabled, read/write prevFrameTexture and swap each frame.
      void settings.noiseReduction?.temporal;
      void this.prevFrameTexture;
    }

    if (isPrimaryColorActive(settings.primaryColor) && settings.primaryColor) {
      const primary = settings.primaryColor;
      const isLast = !hasLaterGpuPass('primary');
      if (isLast) {
        this.primaryColorPass.applyBetweenTextures(
          device,
          current,
          canvasTexture.createView(),
          width,
          height,
          primary,
        );
        wroteToCanvas = true;
      } else {
        runPass(() => {
          this.primaryColorPass.applyBetweenTextures(
            device,
            current,
            next.createView(),
            width,
            height,
            primary,
          );
        });
      }
    }

    if (isSecondaryColorActive(settings.secondaryColor)) {
      // TODO(secondary-color): selective color pass.
    }

    if (isLutFinishingPassActive(settings.lut)) {
      const lut = resolveLutData(lutPassToColorGrade(settings.lut));
      if (lut) {
        this.lutPass.setLut(device, lut);
        const intensity = settings.lut!.intensity;
        const isLastGpuPass = !hasLaterGpuPass('lut');

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
    this.primaryColorPass.destroy();
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
