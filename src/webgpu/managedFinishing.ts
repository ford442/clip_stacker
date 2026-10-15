/**
 * Scene-linear Rec.2020 ("managed") finishing for `FinishingPassChain`: its
 * own pass set and float textures, created on first use. Runs instead of the
 * 8-bit chain whenever color management is active.
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
  normalizeColorManagement,
  odtModeForOutput,
  presentModeToXform,
} from '../utils/colorManagement';
import {
  finishingIntermediateTextureDescriptor,
  type FinishingApplyOptions,
} from './finishingShared';

const WORKING_FORMAT: GPUTextureFormat = 'rgba16float';

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

export class ManagedFinishingChain {
  private readonly format: GPUTextureFormat;
  private managed: ManagedFinishing | null = null;

  constructor(format: GPUTextureFormat) {
    this.format = format;
  }

  /**
   * Scene-linear Rec.2020 finishing. The 8-bit chain in `finishingPassChain.ts`
   * is not used.
   * Order: input → noise → primary → secondary → LUT → sharpen → output → grain → present.
   */
  apply(
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

  /** Invalidate the temporal-denoise history (seek, scrub-back, clip change). */
  resetTemporal(): void {
    if (this.managed) this.managed.prevValid = false;
  }

  destroy(): void {
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
}
