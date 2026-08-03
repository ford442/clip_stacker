/**
 * Ordered finishing pass chain — runs after compositing on WebGPU preview/export.
 *
 * Pass order: noise reduction → primary color → secondary color → LUT → sharpen → grain.
 * Noise reduction, primary color, secondary color, LUT, and sharpen are implemented;
 * grain is a no-op until its effect issue lands.
 */

import { LutPass } from './lutPass';
import { NoiseReductionGpuPass } from './noiseReductionPass';
import { PrimaryColorGpuPass } from './primaryColorPass';
import { SecondaryColorGpuPass } from './secondaryColorPass';
import { SharpenGpuPass } from './sharpenPass';
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
  private readonly secondaryColorPass: SecondaryColorGpuPass;
  private readonly noiseReductionPass: NoiseReductionGpuPass;
  private readonly sharpenPass: SharpenGpuPass;
  private pingTexture: GPUTexture | null = null;
  private pongTexture: GPUTexture | null = null;
  /** Previous frame for temporal denoise — cleared on seek via resetTemporal(). */
  private prevFrameTexture: GPUTexture | null = null;
  /** True after at least one frame has been copied into prevFrameTexture. */
  private prevFrameValid = false;
  private textureWidth = 0;
  private textureHeight = 0;

  private constructor(
    lutPass: LutPass,
    primaryColorPass: PrimaryColorGpuPass,
    secondaryColorPass: SecondaryColorGpuPass,
    noiseReductionPass: NoiseReductionGpuPass,
    sharpenPass: SharpenGpuPass,
  ) {
    this.lutPass = lutPass;
    this.primaryColorPass = primaryColorPass;
    this.secondaryColorPass = secondaryColorPass;
    this.noiseReductionPass = noiseReductionPass;
    this.sharpenPass = sharpenPass;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): FinishingPassChain {
    return new FinishingPassChain(
      LutPass.create(device, format),
      PrimaryColorGpuPass.create(device, format),
      SecondaryColorGpuPass.create(device, format),
      NoiseReductionGpuPass.create(device, format),
      SharpenGpuPass.create(device, format),
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
      after: 'noise' | 'primary' | 'secondary' | 'lut' | 'sharpen',
    ): boolean => {
      if (after === 'noise') {
        return (
          isPrimaryColorActive(settings.primaryColor) ||
          isSecondaryColorActive(settings.secondaryColor) ||
          isLutFinishingPassActive(settings.lut) ||
          isSharpenActive(settings.sharpen) ||
          isGrainActive(settings.grain)
        );
      }
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

    if (isNoiseReductionActive(settings.noiseReduction) && settings.noiseReduction) {
      const nr = settings.noiseReduction;
      const wantsTemporal = Boolean(nr.temporal) && (nr.temporalStrength ?? 0) > 0;
      const prevForShader =
        wantsTemporal && this.prevFrameValid ? this.prevFrameTexture : null;

      const isLast = !hasLaterGpuPass('noise');
      if (isLast) {
        this.noiseReductionPass.applyBetweenTextures(
          device,
          current,
          canvasTexture.createView(),
          width,
          height,
          nr,
          prevForShader,
        );
        wroteToCanvas = true;
        if (wantsTemporal) {
          this.ensurePrevFrameTexture(device, width, height);
          this.copyToPrevFrame(device, canvasTexture, width, height);
          this.prevFrameValid = true;
        }
      } else {
        runPass(() => {
          this.noiseReductionPass.applyBetweenTextures(
            device,
            current,
            next.createView(),
            width,
            height,
            nr,
            prevForShader,
          );
        });
        if (wantsTemporal) {
          this.ensurePrevFrameTexture(device, width, height);
          this.copyToPrevFrame(device, current, width, height);
          this.prevFrameValid = true;
        }
      }
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

    if (isSecondaryColorActive(settings.secondaryColor) && settings.secondaryColor) {
      const secondary = settings.secondaryColor;
      const isLast = !hasLaterGpuPass('secondary');
      if (isLast) {
        this.secondaryColorPass.applyBetweenTextures(
          device,
          current,
          canvasTexture.createView(),
          width,
          height,
          secondary,
        );
        wroteToCanvas = true;
      } else {
        runPass(() => {
          this.secondaryColorPass.applyBetweenTextures(
            device,
            current,
            next.createView(),
            width,
            height,
            secondary,
          );
        });
      }
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

    if (isSharpenActive(settings.sharpen) && settings.sharpen) {
      const sharpen = settings.sharpen;
      const isLast = !hasLaterGpuPass('sharpen');
      if (isLast) {
        this.sharpenPass.applyBetweenTextures(
          device,
          current,
          canvasTexture.createView(),
          width,
          height,
          sharpen,
        );
        wroteToCanvas = true;
      } else {
        runPass(() => {
          this.sharpenPass.applyBetweenTextures(
            device,
            current,
            next.createView(),
            width,
            height,
            sharpen,
          );
        });
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

  /** Clear temporal buffers after timeline seek, scrub-back, or clip change. */
  resetTemporal(): void {
    this.prevFrameTexture?.destroy();
    this.prevFrameTexture = null;
    this.prevFrameValid = false;
  }

  /** True when a valid previous-frame buffer is ready for temporal blend. */
  hasTemporalBuffer(): boolean {
    return this.prevFrameValid && this.prevFrameTexture != null;
  }

  destroy(): void {
    this.pingTexture?.destroy();
    this.pongTexture?.destroy();
    this.prevFrameTexture?.destroy();
    this.lutPass.destroy();
    this.primaryColorPass.destroy();
    this.secondaryColorPass.destroy();
    this.noiseReductionPass.destroy();
    this.sharpenPass.destroy();
    this.pingTexture = null;
    this.pongTexture = null;
    this.prevFrameTexture = null;
    this.prevFrameValid = false;
  }

  private copyToPrevFrame(
    device: GPUDevice,
    source: GPUTexture,
    width: number,
    height: number,
  ): void {
    if (!this.prevFrameTexture) return;
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: source },
      { texture: this.prevFrameTexture },
      [width, height, 1],
    );
    device.queue.submit([encoder.finish()]);
  }

  private ensurePrevFrameTexture(
    device: GPUDevice,
    width: number,
    height: number,
  ): void {
    if (
      this.prevFrameTexture &&
      this.textureWidth === width &&
      this.textureHeight === height
    ) {
      return;
    }
    this.prevFrameTexture?.destroy();
    this.prevFrameTexture = device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
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
