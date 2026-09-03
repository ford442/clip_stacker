/**
 * Ordered finishing pass chain — runs after compositing on WebGPU preview/export.
 *
 * Pass order: noise reduction → primary color → secondary color → LUT → sharpen → grain.
 * Grain / optical emulation is always last so later steps cannot soften the grain.
 *
 * One `queue.submit` per `apply()`: all copies and passes share a command encoder.
 */

import { LutPass } from './lutPass';
import { NoiseReductionGpuPass } from './noiseReductionPass';
import { PrimaryColorGpuPass } from './primaryColorPass';
import { SecondaryColorGpuPass } from './secondaryColorPass';
import { SharpenGpuPass } from './sharpenPass';
import { GrainGpuPass } from './grainPass';
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

export interface FinishingApplyOptions {
  /** Integer frame index for temporal grain seed (export / quantized preview). */
  frameIndex?: number;
}

export function finishingIntermediateTextureDescriptor(
  width: number,
  height: number,
  format: GPUTextureFormat,
): GPUTextureDescriptor {
  return {
    size: [width, height, 1],
    format,
    // Spec GPUTextureUsage flags (numeric so tests can load without WebGPU).
    usage: 0x01 | 0x02 | 0x04 | 0x10, // COPY_SRC | COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT
  };
}

export class FinishingPassChain {
  private readonly lutPass: LutPass;
  private readonly primaryColorPass: PrimaryColorGpuPass;
  private readonly secondaryColorPass: SecondaryColorGpuPass;
  private readonly noiseReductionPass: NoiseReductionGpuPass;
  private readonly sharpenPass: SharpenGpuPass;
  private readonly grainPass: GrainGpuPass;
  private readonly format: GPUTextureFormat;
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
    grainPass: GrainGpuPass,
    format: GPUTextureFormat,
  ) {
    this.lutPass = lutPass;
    this.primaryColorPass = primaryColorPass;
    this.secondaryColorPass = secondaryColorPass;
    this.noiseReductionPass = noiseReductionPass;
    this.sharpenPass = sharpenPass;
    this.grainPass = grainPass;
    this.format = format;
  }

  static create(device: GPUDevice, format: GPUTextureFormat): FinishingPassChain {
    return new FinishingPassChain(
      LutPass.create(device, format),
      PrimaryColorGpuPass.create(device, format),
      SecondaryColorGpuPass.create(device, format),
      NoiseReductionGpuPass.create(device, format),
      SharpenGpuPass.create(device, format),
      GrainGpuPass.create(device, format),
      format,
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
    options?: FinishingApplyOptions,
  ): void {
    if (!isFinishingActive(settings) || width <= 0 || height <= 0) return;

    const frameSeed = Number.isFinite(options?.frameIndex)
      ? Math.max(0, Math.floor(options!.frameIndex as number))
      : 0;

    const canvasTexture = context.getCurrentTexture();
    this.ensurePingPongTextures(device, width, height);

    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: canvasTexture },
      { texture: this.pingTexture! },
      [width, height, 1],
    );

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
          encoder,
        );
        wroteToCanvas = true;
        if (wantsTemporal) {
          this.ensurePrevFrameTexture(device, width, height);
          encoder.copyTextureToTexture(
            { texture: canvasTexture },
            { texture: this.prevFrameTexture! },
            [width, height, 1],
          );
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
            encoder,
          );
        });
        if (wantsTemporal) {
          this.ensurePrevFrameTexture(device, width, height);
          encoder.copyTextureToTexture(
            { texture: current },
            { texture: this.prevFrameTexture! },
            [width, height, 1],
          );
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
          encoder,
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
            encoder,
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
          encoder,
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
            encoder,
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
            encoder,
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
              encoder,
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
          encoder,
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
            encoder,
          );
        });
      }
    }

    if (isGrainActive(settings.grain) && settings.grain) {
      this.grainPass.applyBetweenTextures(
        device,
        current,
        canvasTexture.createView(),
        width,
        height,
        settings.grain,
        frameSeed,
        encoder,
      );
      wroteToCanvas = true;
    }

    if (!wroteToCanvas && current !== this.pingTexture) {
      encoder.copyTextureToTexture(
        { texture: current },
        { texture: canvasTexture },
        [width, height, 1],
      );
    }

    device.queue.submit([encoder.finish()]);
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
    this.grainPass.destroy();
    this.pingTexture = null;
    this.pongTexture = null;
    this.prevFrameTexture = null;
    this.prevFrameValid = false;
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
    this.prevFrameTexture = device.createTexture(
      finishingIntermediateTextureDescriptor(width, height, this.format),
    );
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

    const descriptor = finishingIntermediateTextureDescriptor(width, height, this.format);
    this.pingTexture = device.createTexture(descriptor);
    this.pongTexture = device.createTexture(descriptor);
    this.textureWidth = width;
    this.textureHeight = height;
  }
}
