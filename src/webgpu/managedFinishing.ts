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
import { ChromaticAberrationGpuPass } from './chromaticAberrationPass';
import { CurvesGpuPass } from './curvesPass';
import { BloomGpuPass } from './bloomPass';
import { ColorManagementGpuPass } from './colorManagementPass';
import { GraphicsOverlayPass } from './graphicsOverlayPass';
import { gpuProfilerFor } from './gpuProfiler';
import type { FinishingSettings } from '../finishing/finishing';
import {
  isBloomActive,
  isChromaticAberrationActive,
  isCurvesActive,
  isGrainActive,
  isLutFinishingPassActive,
  isNoiseReductionActive,
  isPrimaryColorActive,
  isSecondaryColorActive,
  isSharpenActive,
  lutPassToColorGrade,
} from '../finishing/finishing';
import { resolveLutData } from '../finishing/lut';
import {
  graphicsWhiteSceneGain,
  inputModeFor,
  normalizeColorManagement,
  odtModeForOutput,
  presentModeToXform,
} from '../finishing/colorManagement';
import {
  finishingIntermediateTextureDescriptor,
  type FinishingApplyOptions,
} from './finishingShared';

const WORKING_FORMAT: GPUTextureFormat = 'rgba16float';
/**
 * The HDR10 PQ image (output encoding, after grain). Half float keeps more
 * than 10 bits of every PQ code the YUV pack reads; an 8-bit target banded.
 */
const PQ_FORMAT: GPUTextureFormat = 'rgba16float';

interface ManagedFinishing {
  source: GPUTexture | null;
  ping: GPUTexture | null;
  pong: GPUTexture | null;
  prev: GPUTexture | null;
  prevValid: boolean;
  pq: GPUTexture | null;
  width: number;
  height: number;
  /**
   * Input and output transforms run in one command encoder, and a pass's
   * uniforms are written with `queue.writeBuffer` before the submit — so one
   * instance used twice would run both draws with the last mode written.
   */
  xformInput: ColorManagementGpuPass;
  xformFloat: ColorManagementGpuPass;
  xformCanvas: ColorManagementGpuPass;
  graphics: GraphicsOverlayPass | null;
  noise: NoiseReductionGpuPass;
  primary: PrimaryColorGpuPass;
  curves: CurvesGpuPass;
  secondary: SecondaryColorGpuPass;
  lut: LutPass;
  sharpen: SharpenGpuPass;
  chromaticAberration: ChromaticAberrationGpuPass;
  bloom: BloomGpuPass;
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
   * Order: input → noise → primary → curves → secondary → LUT → sharpen → chromatic
   * aberration → bloom → output → grain → present. CA and bloom are optical
   * effects, so they run in the scene-linear working space, before the output
   * transform (bloom adds light there instead of screening).
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
    const present = presentModeToXform(
      options?.presentation?.present ?? 'identity',
      options?.presentation?.colorSpace,
    );
    const frameSeed = Number.isFinite(options?.frameIndex)
      ? Math.max(0, Math.floor(options!.frameIndex as number))
      : 0;

    this.ensureManaged(device);
    this.ensureManagedTextures(device, width, height);
    const managed = this.managed!;
    const encoder = device.createCommandEncoder();
    const profiler = gpuProfilerFor(device);
    const profile = (label: string, active: boolean): number | null =>
      active && profiler ? profiler.begin(encoder, label) : null;
    const canvasTexture = context.getCurrentTexture();
    encoder.copyTextureToTexture(
      { texture: canvasTexture },
      { texture: managed.source! },
      [width, height, 1],
    );

    const pInput = profile('colour in', true);
    managed.xformInput.applyBetweenTextures(
      device,
      managed.source!,
      managed.ping!.createView(),
      inputModeFor(options?.importColorSpace ?? 'srgb'),
      encoder,
    );
    profiler?.end(encoder, pInput);

    let current = managed.ping!;
    let next = managed.pong!;
    const swap = () => {
      const tmp = current;
      current = next;
      next = tmp;
    };

    const pNoise = profile(
      `NR ${settings.noiseReduction?.quality ?? 'standard'}`,
      isNoiseReductionActive(settings.noiseReduction),
    );
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
    profiler?.end(encoder, pNoise);

    const pPrimary = profile('primary', isPrimaryColorActive(settings.primaryColor));
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
    profiler?.end(encoder, pPrimary);

    const pCurves = profile('curves', isCurvesActive(settings.curves));
    if (isCurvesActive(settings.curves) && settings.curves) {
      managed.curves.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        settings.curves,
        encoder,
      );
      swap();
    }
    profiler?.end(encoder, pCurves);

    const pSecondary = profile('secondary', isSecondaryColorActive(settings.secondaryColor));
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
    profiler?.end(encoder, pSecondary);

    const pLut = profile('LUT', isLutFinishingPassActive(settings.lut));
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
    profiler?.end(encoder, pLut);

    const pSharpen = profile('sharpen', isSharpenActive(settings.sharpen));
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
    profiler?.end(encoder, pSharpen);

    const pCa = profile('CA', isChromaticAberrationActive(settings.chromaticAberration));
    if (
      isChromaticAberrationActive(settings.chromaticAberration) &&
      settings.chromaticAberration
    ) {
      managed.chromaticAberration.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        settings.chromaticAberration,
        encoder,
      );
      swap();
    }
    profiler?.end(encoder, pCa);

    const pBloom = profile('bloom', isBloomActive(settings.bloom));
    if (isBloomActive(settings.bloom) && settings.bloom) {
      managed.bloom.applyBetweenTextures(
        device,
        current,
        next.createView(),
        width,
        height,
        settings.bloom,
        encoder,
      );
      swap();
    }
    profiler?.end(encoder, pBloom);

    // Titles and captions of an HDR10 frame: composited in the working space
    // at the graphics white, so the PQ file carries them (not drawn later
    // over the 8-bit canvas). Last before the output transform, so no
    // optical pass blooms or fringes them; grain still runs over them.
    const pTitles = profile(
      'HDR titles',
      Boolean(color.outputColor === 'hdr10' && options?.graphicsOverlay),
    );
    if (color.outputColor === 'hdr10' && options?.graphicsOverlay) {
      managed.graphics ??= GraphicsOverlayPass.create(device, WORKING_FORMAT);
      managed.graphics.composite(
        device,
        encoder,
        options.graphicsOverlay,
        current.createView(),
        width,
        height,
        graphicsWhiteSceneGain(color),
      );
    }
    profiler?.end(encoder, pTitles);

    const pOutput = profile('colour out', true);
    managed.xformFloat.applyBetweenTextures(
      device,
      current,
      next.createView(),
      odtModeForOutput(color.outputColor),
      encoder,
    );
    swap();
    profiler?.end(encoder, pOutput);

    const pGrain = profile('grain', isGrainActive(settings.grain));
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
    profiler?.end(encoder, pGrain);

    if (color.outputColor === 'hdr10' && managed.pq) {
      encoder.copyTextureToTexture({ texture: current }, { texture: managed.pq }, [width, height, 1]);
    }

    const pPresent = profile('present', true);
    managed.xformCanvas.applyBetweenTextures(
      device,
      current,
      canvasTexture.createView(),
      present,
      encoder,
    );
    profiler?.end(encoder, pPresent);

    device.queue.submit([encoder.finish()]);
  }

  /** Half-float PQ image (Rec.2020 R'G'B') of the last managed HDR10 frame, or null. */
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
      xformInput: ColorManagementGpuPass.create(device, WORKING_FORMAT),
      xformFloat: ColorManagementGpuPass.create(device, WORKING_FORMAT),
      xformCanvas: ColorManagementGpuPass.create(device, this.format),
      graphics: null,
      noise: NoiseReductionGpuPass.create(device, WORKING_FORMAT, true),
      primary: PrimaryColorGpuPass.create(device, WORKING_FORMAT),
      curves: CurvesGpuPass.create(device, WORKING_FORMAT, true),
      secondary: SecondaryColorGpuPass.create(device, WORKING_FORMAT, true),
      lut: LutPass.create(device, WORKING_FORMAT, true),
      sharpen: SharpenGpuPass.create(device, WORKING_FORMAT, true),
      chromaticAberration: ChromaticAberrationGpuPass.create(device, WORKING_FORMAT),
      bloom: BloomGpuPass.create(device, WORKING_FORMAT, true),
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
      finishingIntermediateTextureDescriptor(width, height, PQ_FORMAT),
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
    managed.xformInput.destroy();
    managed.xformFloat.destroy();
    managed.xformCanvas.destroy();
    managed.graphics?.destroy();
    managed.noise.destroy();
    managed.primary.destroy();
    managed.curves.destroy();
    managed.secondary.destroy();
    managed.lut.destroy();
    managed.sharpen.destroy();
    managed.chromaticAberration.destroy();
    managed.bloom.destroy();
    managed.grain.destroy();
    this.managed = null;
  }
}
