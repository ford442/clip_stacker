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
import { ColorManagementGpuPass } from './colorManagementPass';
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
import {
  ColorXformMode,
  isColorManagementActive,
  normalizeColorManagement,
  odtModeForOutput,
  presentModeToXform,
  type CanvasPresentation,
  type ColorManagementSettings,
} from '../utils/colorManagement';

const WORKING_FORMAT: GPUTextureFormat = 'rgba16float';

export interface FinishingApplyOptions {
  /** Integer frame index for temporal grain seed (export / quantized preview). */
  frameIndex?: number;
  /** When active, finishing runs in scene-linear Rec.2020 instead of 8-bit Rec.709. */
  colorManagement?: ColorManagementSettings;
  /** How the managed path should write the swapchain. Ignored on the default path. */
  presentation?: CanvasPresentation;
}

interface ManagedFinishing {
  source: GPUTexture | null;
  ping: GPUTexture | null;
  pong: GPUTexture | null;
  prev: GPUTexture | null;
  prevValid: boolean;
  pq: GPUTexture | null;
  width: number;
  height: number;
  xformFloat: ColorManagementGpuPass;
  xformCanvas: ColorManagementGpuPass;
  xformUnorm: ColorManagementGpuPass;
  noise: NoiseReductionGpuPass;
  primary: PrimaryColorGpuPass;
  secondary: SecondaryColorGpuPass;
  lut: LutPass;
  sharpen: SharpenGpuPass;
  grain: GrainGpuPass;
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
  private managed: ManagedFinishing | null = null;

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
    if (width <= 0 || height <= 0) return;
    if (isColorManagementActive(options?.colorManagement)) {
      this.applyManaged(device, context, width, height, settings, options);
      return;
    }
    if (!isFinishingActive(settings)) return;

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

  /**
   * Scene-linear Rec.2020 finishing. The 8-bit chain above is not used.
   * Order: input → noise → primary → secondary → LUT → sharpen → output → grain → present.
   */
  private applyManaged(
    device: GPUDevice,
    context: GPUCanvasContext,
    width: number,
    height: number,
    settings: FinishingSettings,
    options: FinishingApplyOptions | undefined,
  ): void {
    const color = normalizeColorManagement(options?.colorManagement);
    const present = presentModeToXform(options?.presentation?.present ?? 'identity');
    const frameSeed = Number.isFinite(options?.frameIndex)
      ? Math.max(0, Math.floor(options!.frameIndex as number))
      : 0;

    this.ensureManaged(device);
    this.ensureManagedTextures(device, width, height);
    const managed = this.managed!;
    const encoder = device.createCommandEncoder();
    const canvasTexture = context.getCurrentTexture();
    encoder.copyTextureToTexture(
      { texture: canvasTexture },
      { texture: managed.source! },
      [width, height, 1],
    );

    managed.xformFloat.applyBetweenTextures(
      device,
      managed.source!,
      managed.ping!.createView(),
      ColorXformMode.inputRec709ToLinear2020,
      encoder,
    );

    let current = managed.ping!;
    let next = managed.pong!;
    const swap = () => {
      const tmp = current;
      current = next;
      next = tmp;
    };

    if (isNoiseReductionActive(settings.noiseReduction) && settings.noiseReduction) {
      const nr = settings.noiseReduction;
      const wantsTemporal = Boolean(nr.temporal) && (nr.temporalStrength ?? 0) > 0;
      const prev = wantsTemporal && managed.prevValid ? managed.prev : null;
      managed.noise.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        nr,
        prev,
        encoder,
      );
      swap();
      if (wantsTemporal && managed.prev) {
        encoder.copyTextureToTexture(
          { texture: current },
          { texture: managed.prev },
          [width, height, 1],
        );
        managed.prevValid = true;
      }
    }

    if (isPrimaryColorActive(settings.primaryColor) && settings.primaryColor) {
      managed.primary.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        settings.primaryColor,
        encoder,
        true,
      );
      swap();
    }

    if (isSecondaryColorActive(settings.secondaryColor) && settings.secondaryColor) {
      managed.secondary.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        settings.secondaryColor,
        encoder,
      );
      swap();
    }

    if (isLutFinishingPassActive(settings.lut)) {
      const lut = resolveLutData(lutPassToColorGrade(settings.lut));
      if (lut) {
        managed.lut.setLut(device, lut);
        managed.lut.applyBetweenTextures(
          device,
          current,
          next.createView(),
          width,
          height,
          settings.lut!.intensity,
          encoder,
        );
        swap();
      }
    }

    if (isSharpenActive(settings.sharpen) && settings.sharpen) {
      managed.sharpen.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        settings.sharpen,
        encoder,
      );
      swap();
    }

    managed.xformFloat.applyBetweenTextures(
      device,
      current,
      next.createView(),
      odtModeForOutput(color.outputColor),
      encoder,
    );
    swap();

    if (isGrainActive(settings.grain) && settings.grain) {
      managed.grain.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        settings.grain,
        frameSeed,
        encoder,
      );
      swap();
    }

    if (color.outputColor === 'hdr10' && managed.pq) {
      managed.xformUnorm.applyBetweenTextures(
        device,
        current,
        managed.pq.createView(),
        ColorXformMode.presentIdentity,
        encoder,
      );
    }

    managed.xformCanvas.applyBetweenTextures(
      device,
      current,
      canvasTexture.createView(),
      present,
      encoder,
    );

    device.queue.submit([encoder.finish()]);
  }

  /** RGBA8 PQ image from the last managed HDR10 frame, or null. */
  getPqExportTexture(): GPUTexture | null {
    return this.managed?.pq ?? null;
  }

  /** Clear temporal buffers after timeline seek, scrub-back, or clip change. */
  resetTemporal(): void {
    this.prevFrameTexture?.destroy();
    this.prevFrameTexture = null;
    this.prevFrameValid = false;
    if (this.managed) this.managed.prevValid = false;
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
    this.destroyManaged();
  }

  private ensureManaged(device: GPUDevice): void {
    if (this.managed) return;
    this.managed = {
      source: null,
      ping: null,
      pong: null,
      prev: null,
      prevValid: false,
      pq: null,
      width: 0,
      height: 0,
      xformFloat: ColorManagementGpuPass.create(device, WORKING_FORMAT),
      xformCanvas: ColorManagementGpuPass.create(device, this.format),
      xformUnorm: ColorManagementGpuPass.create(device, 'rgba8unorm'),
      noise: NoiseReductionGpuPass.create(device, WORKING_FORMAT, true),
      primary: PrimaryColorGpuPass.create(device, WORKING_FORMAT),
      secondary: SecondaryColorGpuPass.create(device, WORKING_FORMAT, true),
      lut: LutPass.create(device, WORKING_FORMAT, true),
      sharpen: SharpenGpuPass.create(device, WORKING_FORMAT, true),
      grain: GrainGpuPass.create(device, WORKING_FORMAT),
    };
  }

  private ensureManagedTextures(device: GPUDevice, width: number, height: number): void {
    const managed = this.managed;
    if (!managed) return;
    if (managed.ping && managed.width === width && managed.height === height) return;
    managed.source?.destroy();
    managed.ping?.destroy();
    managed.pong?.destroy();
    managed.prev?.destroy();
    managed.pq?.destroy();
    managed.source = device.createTexture(
      finishingIntermediateTextureDescriptor(width, height, this.format),
    );
    managed.ping = device.createTexture(
      finishingIntermediateTextureDescriptor(width, height, WORKING_FORMAT),
    );
    managed.pong = device.createTexture(
      finishingIntermediateTextureDescriptor(width, height, WORKING_FORMAT),
    );
    managed.prev = device.createTexture(
      finishingIntermediateTextureDescriptor(width, height, WORKING_FORMAT),
    );
    managed.pq = device.createTexture(
      finishingIntermediateTextureDescriptor(width, height, 'rgba8unorm'),
    );
    managed.prevValid = false;
    managed.width = width;
    managed.height = height;
  }

  private destroyManaged(): void {
    const managed = this.managed;
    if (!managed) return;
    managed.source?.destroy();
    managed.ping?.destroy();
    managed.pong?.destroy();
    managed.prev?.destroy();
    managed.pq?.destroy();
    managed.xformFloat.destroy();
    managed.xformCanvas.destroy();
    managed.xformUnorm.destroy();
    managed.noise.destroy();
    managed.primary.destroy();
    managed.secondary.destroy();
    managed.lut.destroy();
    managed.sharpen.destroy();
    managed.grain.destroy();
    this.managed = null;
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
